'use strict';
/**
 * FR-601 课程知识图谱检索 / FR-103 概念精讲
 * 讲解结构固定为：一句话定义 → 类比 → 课程内示例 → 常见误解 → 自测追问
 * 图谱中无此概念时明确告知并给出相近概念，禁止凭空编造（FR-103 边界）
 */
const db = require('../db');
const { jparse } = require('./util');

function parseNode(r) {
  if (!r) return null;
  return {
    ...r,
    misconceptions: jparse(r.misconceptions, []),
    resources: jparse(r.resources, []),
    target_ids: jparse(r.target_ids, []),
    keywords: jparse(r.keywords, []),
  };
}

/** 关键词检索：全名命中 > 别名命中 > 定义包含 */
function search(query, limit = 3) {
  const q = String(query || '').trim();
  if (!q) return [];
  const rows = db.all('SELECT * FROM knowledge_nodes').map(parseNode);

  const scored = [];
  for (const n of rows) {
    let score = 0;
    if (n.name === q) score = 100;
    else if (q.includes(n.name) || n.name.includes(q)) score = 80;
    else if ((n.keywords || []).some((k) => q.includes(k) || k.includes(q))) score = 60;
    else if ((n.definition || '').includes(q)) score = 30;
    if (score > 0) scored.push({ node: n, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.node);
}

/** 相近概念（用于「图谱无此概念」时的降级提示） */
function suggest(query, limit = 3) {
  const q = String(query || '').trim();
  if (!q) return [];
  const rows = db.all('SELECT * FROM knowledge_nodes').map(parseNode);
  const chars = new Set(q.split(''));
  return rows
    .map((n) => {
      let overlap = 0;
      for (const c of new Set(n.name)) if (chars.has(c)) overlap++;
      return { node: n, overlap };
    })
    .filter((x) => x.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, limit)
    .map((x) => x.node);
}

/** 生成结构化讲解卡片（FR-103） */
function explain(node, baseLevel = '初学') {
  const n = typeof node === 'string' ? search(node, 1)[0] : node;
  if (!n) {
    const near = suggest(typeof node === 'string' ? node : '', 3);
    return {
      found: false,
      text:
        `这个概念在我的课程知识图谱里没有记录——我不编，直接告诉你没有。\n` +
        (near.length
          ? `相近的概念有：${near.map((x) => x.name).join('、')}。你说的是其中哪一个？\n如果你确定就是「${node}」，把它交给老师补进图谱，我下次就能讲了。`
          : `你能把它换个说法，或者告诉我它出现在哪个环节？我按环节帮你定位。`),
      knowledge_tags: [],
    };
  }

  const mis = n.misconceptions && n.misconceptions.length
    ? `\n常见误解：${n.misconceptions.slice(0, 2).join('；')}`
    : '';
  const res = n.resources && n.resources.length
    ? `\n延伸：${n.resources.slice(0, 2).join(' / ')}`
    : '';
  const analogy =
    baseLevel === '进阶'
      ? `\n类比：可以把${n.name}想成一种「约束」——它不直接产生功能，但决定了功能能不能长期成立。`
      : `\n类比：${n.name}有点像${analogyFor(n.name)}。`;

  const text =
    `**${n.name}**\n` +
    `一句话：${n.definition || '（图谱暂无定义，待教师补充）'}` +
    analogy +
    `\n课程里怎么用：${courseExample(n.name)}` +
    mis +
    res +
    `\n\n自测一句：${quizFor(n.name)}\n（先回答这句，答完我再往下展开。）`;

  return {
    found: true,
    text,
    nodeId: n.node_id,
    knowledge_tags: [n.name],
  };
}

function analogyFor(name) {
  const map = {
    用户故事: '给团队留的一张便条——只写清谁要什么、为什么，细节留给对话',
    INVEST: '一份体检清单：每项都过一遍，才知道这个故事是否健康',
    验收标准: '验收单：不写「感觉不错」，只写「能看到什么就算合格」',
    等价类划分: '抽样检测：同一批货抽一件，而不是每件都拆',
    边界值分析: '量尺寸时卡在吻合与不吻合的那一毫米上',
    单一职责: '厨房里切菜的和炒菜的分工，一个人全干会堵',
    依赖倒置: '插座不关心插的是什么电器，只定接口',
    持续集成: '每天把各人的改动合一次，避免最后一天才发现合不上',
    技术债: '为了赶工先借的债，利息是以后每次改动都更费劲',
    回归测试: '改完再跑一遍老用例，确认没把别的碰坏',
    故事点: '相对尺码：不说几小时，只说比另一件大还是小',
  };
  return map[name] || '给复杂事情加的一层规矩——规矩本身不解决问题，但能让问题不失控';
}

function courseExample(name) {
  const map = {
    用户故事: '你们这轮要写的故事卡就是它，评审时按它逐条过',
    INVEST: '写完故事卡后自检一遍，尤其是 V（价值）和 T（可测试）两项',
    验收标准: '需求澄清阶段最后一步，写完就能直接转成测试用例',
    等价类划分: '测试验证阶段设计用例的第一步',
    边界值分析: '在等价类分好之后，专门补分界点两侧的取值',
    单一职责: '编码结对阶段判断一个类该不该拆的依据',
    依赖倒置: '架构设计阶段判断模块是否可替换的依据',
    持续集成: 'Sprint 里每天合并一次，避免最后一天才发现合不上',
    技术债: '复盘阶段待改进项里最常见的一类',
    回归测试: '每次改动后重跑老用例，确认没碰坏别的功能',
    故事点: '估算时用的相对单位，不是工时',
  };
  return map[name] || '它会出现在你们项目推进的某个环节，遇到时我再结合你们的场景讲';
}

function quizFor(name) {
  const map = {
    用户故事: '你的故事里「以便」那半句写了吗？没写的话，它凭什么排进这个 Sprint？',
    INVEST: '六项里你觉得自己最可能挂在哪一项？说一个。',
    验收标准: '你写的标准里，有几条是异常分支？',
    等价类划分: '你的输入能分成几类？分类的边界条件是什么？',
    边界值分析: '你找到的那个边界，它两侧的值分别是什么？',
    单一职责: '你的这个类，会因为几个不同的理由被修改？',
    依赖倒置: '如果换一个数据库，你要改几个类？',
    持续集成: '你们现在多久合并一次？超过一天会怎样？',
    技术债: '你这轮欠下的债，下轮还的时候要付多少利息？',
    回归测试: '你改完这个功能，重跑了哪些老用例？',
    故事点: '这个故事比你们做过的哪个故事大？大多少？',
  };
  return map[name] || `用自己的话讲一遍${name}，并说一个你们项目里会用到它的地方。`;
}

/** 打标：从文本中匹配知识点（低置信度不打标，FR-502 风险应对） */
function tag(text, threshold = 1) {
  const t = String(text || '');
  const rows = db.all('SELECT * FROM knowledge_nodes').map(parseNode);
  const tags = [];
  for (const n of rows) {
    let hits = 0;
    if (t.includes(n.name)) hits += 2;
    for (const k of n.keywords || []) if (t.includes(k)) hits += 1;
    if (hits >= threshold) tags.push({ id: n.node_id, name: n.name, hits });
  }
  tags.sort((a, b) => b.hits - a.hits);
  return tags.slice(0, 3).map((x) => x.name);
}

module.exports = { search, suggest, explain, tag, parseNode };
