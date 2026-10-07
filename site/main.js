const snippets = {
  codex: ['node src/cli.mjs install-mcp --target codex', '在解压目录运行，复制输出的注册命令执行；随后检查 MCP 连接状态。'],
  workbuddy: ['node src/cli.mjs install-mcp --target workbuddy --write', '自动备份并合并 MCP 配置；在客户端信任该服务，再重启连接。'],
};
const tabs = [...document.querySelectorAll('[data-client]')];
function selectTab(tab) {
  tabs.forEach(t => { t.setAttribute('aria-selected', String(t === tab)); t.tabIndex = t === tab ? 0 : -1; });
  document.querySelector('#client-code').textContent = snippets[tab.dataset.client][0];
  document.querySelector('#client-code').setAttribute('aria-labelledby', tab.id);
  document.querySelector('#client-tip').textContent = snippets[tab.dataset.client][1];
}
tabs.forEach((tab, i) => { tab.addEventListener('click', () => selectTab(tab)); tab.addEventListener('keydown', e => { if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) { e.preventDefault(); const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length; selectTab(tabs[next]); tabs[next].focus(); } }); });
selectTab(tabs[0]);
document.querySelector('#copy-prompt').addEventListener('click', async () => {
  const status = document.querySelector('#copy-status');
  try { await navigator.clipboard.writeText(document.querySelector('#agent-prompt').textContent); status.textContent = '已复制，粘贴到已连接 MCP 的 Agent 即可。'; }
  catch { status.textContent = '请选中右侧指令手动复制。'; }
});
