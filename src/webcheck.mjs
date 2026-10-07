/**
 * 网页自检（无需浏览器）：
 *   1) 提取 index.html 中的内联 <script>，用 node --check 校验语法
 *   2) 校验 JS 里引用的所有 #id 都能在 HTML 中找到对应元素
 *   3) 校验关键交互元素与 fetch 端点齐全
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.resolve(__dirname, '..', 'public', 'index.html');

let failed = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => {
  failed += 1;
  console.log(`  ✗ ${m}`);
};

const html = fs.readFileSync(HTML, 'utf8');

// 1) 内联脚本语法
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
if (!scripts.length) bad('未找到内联 script');
else {
  const js = scripts.join('\n;\n');
  const tmp = path.join(os.tmpdir(), `zhuque-inline-${Date.now()}.mjs`);
  fs.writeFileSync(tmp, js, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    ok(`内联脚本语法通过（${js.length} 字符）`);
  } catch (e) {
    bad(`内联脚本语法错误：\n${e.stderr?.toString() || e.message}`);
  }
  fs.unlinkSync(tmp);

  // 2) #id 引用完整性（排除运行时动态创建的 id）
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const dynamic = new Set([...js.matchAll(/\.id\s*=\s*'([A-Za-z0-9_-]+)'/g)].map((m) => m[1]));
  const used = new Set();
  for (const m of js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)) used.add(m[1]);
  for (const m of js.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) used.add(m[1]);
  const missing = [...used].filter((i) => !ids.has(i) && !dynamic.has(i));
  if (missing.length) bad(`JS 引用了不存在的元素 id：${missing.join(', ')}`);
  else ok(`JS 引用的 ${used.size} 个元素 id 均存在${dynamic.size ? `（其中 ${dynamic.size} 个为运行时动态创建：${[...dynamic].join(', ')}）` : ''}`);

  // 3) 关键交互与端点
  const need = [
    ['/api/detect', '检测接口调用'],
    ['/api/health', '健康检查'],
    ['/api/usage', '用量查询'],
    ['/api/history', '检测历史'],
    ['/api/keys', 'Key 池管理'],
    ['/api/config', '配置读写'],
    ['/api/mcp-config', 'MCP 入口路径获取'],
    ['runBtn', '检测按钮绑定'],
    ['renderMcpBox', 'MCP 配置块渲染函数'],
    ['renderCatCards', '三段占比卡片渲染函数'],
    ['renderSegs', '逐段归属渲染函数'],
    ['renderKeyPool', 'Key 池渲染函数'],
    ['loadHistory', '历史加载函数'],
  ];
  for (const [token, label] of need) {
    if (html.includes(token)) ok(`${label}（${token}）已就绪`);
    else bad(`缺少 ${label}（${token}）`);
  }

  // 4) 三段占比口径必须与朱雀官网对齐
  for (const label of ['人工特征', '疑似 AI', 'AI 特征']) {
    if (html.includes(label)) ok(`三段分类文案「${label}」已就绪`);
    else bad(`缺少三段分类文案「${label}」`);
  }

  // 5) 不应残留未替换的模板占位符
  if (html.includes('__MCP_PATH__')) bad('仍残留 __MCP_PATH__ 占位符（会直接显示给用户）');
  else ok('无未替换的模板占位符');
}

console.log(`\n${failed ? `失败 ${failed} 项` : '全部通过'}\n`);
process.exitCode = failed ? 1 : 0;
