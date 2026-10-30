'use strict';
/**
 * FR-105 多模态输入处理
 *
 * 输入分三类：
 *   - 代码文件（.js/.ts/.java/.py 等，≤200KB）：识别语言 + 抽取结构
 *     （类 / 函数 / 方法 / 导入依赖 / 行数），高置信度，向学生复述确认；
 *   - Markdown / 文本片段（.md/.txt/.csv/.json）：提取标题结构与行数，高置信度；
 *   - 图片（PNG/JPG 等，≤10MB）：当前未接入 OCR / 视觉模型，
 *     置信度低于阈值 → 明确反问学生确认内容，不臆测（FR-105 边界）。
 *
 * 所有附件落盘留痕（data/uploads/）并写 attachments 表，解析结果可回传教师端。
 */
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const { uid, now } = require('./util');

const UPLOAD_DIR = process.env.ZHITU_UPLOAD_DIR || path.join(__dirname, '..', '..', 'data', 'uploads');

const TEXT_EXTS = ['.txt', '.md', '.markdown', '.csv', '.json', '.yml', '.yaml', '.xml', '.html', '.log', '.ini', '.sql'];
const CODE_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.java', '.py', '.c', '.h', '.cpp', '.go', '.rs', '.php', '.rb', '.kt', '.swift', '.cs', '.sh', '.bat', '.ps1'];
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg'];

const CODE_LIMIT = 200 * 1024;   // 200KB
const IMAGE_LIMIT = 10 * 1024 * 1024; // 10MB

function extOf(name) {
  return path.extname(String(name || '')).toLowerCase();
}

function kindOf(name, mime) {
  const e = extOf(name);
  if (CODE_EXTS.includes(e)) return 'code';
  if (IMAGE_EXTS.includes(e)) return 'image';
  if (TEXT_EXTS.includes(e)) return 'text';
  if (/^text\//.test(String(mime || ''))) return 'text';
  return 'other';
}

function langOf(name) {
  const e = extOf(name);
  const map = {
    '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
    '.ts': 'TypeScript', '.tsx': 'TypeScript React', '.jsx': 'JavaScript React',
    '.java': 'Java', '.py': 'Python', '.c': 'C', '.h': 'C Header', '.cpp': 'C++',
    '.go': 'Go', '.rs': 'Rust', '.php': 'PHP', '.rb': 'Ruby', '.kt': 'Kotlin',
    '.swift': 'Swift', '.cs': 'C#', '.sh': 'Shell', '.bat': 'Batch', '.ps1': 'PowerShell',
    '.md': 'Markdown', '.csv': 'CSV', '.json': 'JSON', '.yml': 'YAML', '.yaml': 'YAML',
    '.sql': 'SQL', '.html': 'HTML', '.xml': 'XML',
  };
  return map[e] || null;
}

/**
 * 代码结构抽取：类 / 函数 / 导入依赖（正则口径，教学演示足够且可解释）
 */
function parseCode(name, text) {
  const lines = text.split('\n');
  const nonEmpty = lines.filter((l) => l.trim()).length;
  const result = {
    language: langOf(name) || '未知',
    totalLines: lines.length,
    codeLines: nonEmpty,
    imports: [],
    classes: [],
    functions: [],
  };
  const importRes = [
    /^\s*import\s+[^;]+?from\s+['"]([^'"]+)['"]/,          // esm
    /^\s*const\s+[^=]+=\s*require\(['"]([^'"]+)['"]\)/,     // cjs
    /^\s*import\s+([a-zA-Z0-9_.]+)\s*$/,                    // py
    /^\s*from\s+([a-zA-Z0-9_.]+)\s+import/,                 // py
    /^\s*import\s+([a-zA-Z0-9_.]+);/,                       // java
    /^\s*package\s+([a-zA-Z0-9_.]+);/,                      // java
  ];
  const classRes = [
    /(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    /^\s*class\s+([A-Za-z_][\w]*)/,                          // py
  ];
  const funcRes = [
    /(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
    /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/,
    /^\s*def\s+([A-Za-z_][\w]*)/,                            // py
    /(?:public|private|protected|static|\s)+[\w<>\[\]]+\s+([A-Za-z_][\w]*)\s*\([^)]*\)\s*\{/, // java 方法（粗匹配）
  ];
  lines.forEach((l) => {
    for (const re of importRes) {
      const m = l.match(re);
      if (m) { result.imports.push(m[1]); break; }
    }
    for (const re of classRes) {
      const m = l.match(re);
      if (m) { result.classes.push(m[1]); break; }
    }
    for (const re of funcRes) {
      const m = l.match(re);
      if (m && !result.classes.includes(m[1])) { result.functions.push(m[1]); break; }
    }
  });
  result.imports = [...new Set(result.imports)].slice(0, 20);
  result.classes = [...new Set(result.classes)].slice(0, 20);
  result.functions = [...new Set(result.functions)].slice(0, 40);
  return result;
}

/** Markdown / 文本片段：标题结构 */
function parseText(name, text) {
  const headings = text.split('\n')
    .map((l) => l.match(/^(#{1,4})\s+(.+)$/))
    .filter(Boolean)
    .map((m) => m[1].length + '级 · ' + m[2].trim())
    .slice(0, 20);
  return {
    language: langOf(name) || '纯文本',
    totalLines: text.split('\n').length,
    chars: text.length,
    headings,
  };
}

/**
 * 解析单个附件（入口）。
 * @param {{name,mime,size,text,dataUrl}} a 前端已读出的内容
 * @returns {{kind,confidence,parse,confirmText,question}}
 */
function analyze(a) {
  const name = a.name || '未命名';
  const size = Number(a.size || 0);
  const kind = kindOf(name, a.mime);

  if (kind === 'image') {
    if (size > IMAGE_LIMIT) {
      return {
        kind, confidence: 0, parse: { error: 'OVERSIZE', limit: IMAGE_LIMIT },
        question: `「${name}」超过 10MB 上限，发不了。可以截小一点，或直接用文字描述你想让我看的地方。`,
      };
    }
    // 低置信度：未启用视觉理解，明确反问，不臆测（FR-105 验收标准）
    return {
      kind,
      confidence: 0.2,
      parse: { note: '未启用 OCR / 视觉模型，按低置信度处理' },
      question: `我收到截图「${name}」，但当前没有视觉理解能力，我不会猜里面的内容。` +
        '请用一两句话告诉我：图里是什么（报错 / UML / 代码），你想让我看哪一部分？',
    };
  }

  // 文本 / 代码：必须有可读文本
  // 兼容两种入参命名：前端上传组件传 content，内部调用可用 text
  const text = typeof a.text === 'string' ? a.text
    : typeof a.content === 'string' ? a.content : '';
  if (!text) {
    return {
      kind: 'other', confidence: 0.1,
      parse: { note: '非文本内容且未提供文本' },
      question: `「${name}」我读不出内容（不是文本格式）。它是什么？换代码片段粘贴或文本描述给我。`,
    };
  }
  if (size > CODE_LIMIT) {
    return {
      kind, confidence: 0.3,
      parse: { error: 'OVERSIZE', limit: CODE_LIMIT },
      question: `「${name}」超过 200KB，我只看了前面一部分。核心部分可以单独贴出来。`,
    };
  }

  const parse = kind === 'code' ? parseCode(name, text) : parseText(name, text);
  // 复述确认：把「我理解到了什么」说给学生听，允许纠正（FR-105 输出要求）
  let confirmText;
  if (kind === 'code') {
    const parts = [`${parse.language}，${parse.totalLines} 行`];
    if (parse.classes.length) parts.push(`${parse.classes.length} 个类（${parse.classes.slice(0, 3).join('、')}）`);
    if (parse.functions.length) parts.push(`${parse.functions.length} 个函数/方法`);
    if (parse.imports.length) parts.push(`依赖 ${parse.imports.length} 个模块`);
    confirmText = `收到代码文件「${name}」（${parts.join('，')}）。我先按这个结构理解它——如果和你写的不符，直接纠正我。`;
  } else {
    const h = parse.headings && parse.headings.length;
    confirmText = `收到文档「${name}」（${parse.totalLines} 行${h ? '，' + h + ' 个标题' : ''}）。我按 ${parse.language} 处理——你想让我重点看哪一节？`;
  }
  return { kind, confidence: 0.9, parse, confirmText };
}

/** 落盘 + 落库留痕，返回附件记录 */
function persist({ studentId, sessionId, msgId, name, mime, size, kind, parse, content }) {
  let storedPath = null;
  try {
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const id = uid('at');
    const safe = String(name || 'file').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
    storedPath = path.join(UPLOAD_DIR, id + '_' + safe);
    fs.writeFileSync(storedPath, Buffer.from(String(content || ''), 'utf8'));
    db.insert('attachments', {
      id, msg_id: msgId || null, session_id: sessionId || null,
      student_id: studentId || null, name, mime: mime || null,
      size: size || 0, kind, parse_result: JSON.stringify(parse || {}),
      stored_path: storedPath, created_at: now(),
    });
    return { id, storedPath };
  } catch (_) {
    return { id: null, storedPath: null };
  }
}

/**
 * 批量处理一条消息的附件：
 * @returns {{note:string, question:string|null, records:object[]}}
 *   note     拼进消息文本的复述确认（高置信度附件）
 *   question 低置信度附件的反问（作为本轮引导输出）
 */
function handleAttachments({ studentId, sessionId, msgId, attachments }) {
  if (!Array.isArray(attachments) || !attachments.length) return { note: '', question: null, records: [] };
  const records = [];
  const confirms = [];
  const questions = [];
  for (const a of attachments.slice(0, 5)) {
    const r = analyze(a);
    records.push({ name: a.name, kind: r.kind, confidence: r.confidence, parse: r.parse });
    if (r.confirmText) confirms.push(r.confirmText);
    if (r.question) questions.push(r.question);
    persist({
      studentId, sessionId, msgId,
      name: a.name, mime: a.mime, size: a.size, kind: r.kind,
      parse: { ...r.parse, confidence: r.confidence },
      content: typeof a.text === 'string' ? a.text
        : (typeof a.content === 'string' ? a.content : (a.dataUrl || '')),
    });
  }
  return {
    note: confirms.length ? '\n（附件解析：' + confirms.join(' ') + '）' : '',
    question: questions.length ? questions.join('\n') : null,
    records,
  };
}

/** 教师端 / 学生端查看某会话的附件留痕 */
function listOfSession(sessionId) {
  return db.all(
    'SELECT id, name, mime, size, kind, parse_result, created_at FROM attachments WHERE session_id=? ORDER BY created_at DESC LIMIT 50',
    [sessionId]
  ).map((r) => ({ ...r, parse: JSON.parse(r.parse_result || '{}') }));
}

module.exports = {
  analyze, handleAttachments, listOfSession,
  kindOf, langOf, parseCode, parseText, UPLOAD_DIR,
  CODE_LIMIT, IMAGE_LIMIT,
};
