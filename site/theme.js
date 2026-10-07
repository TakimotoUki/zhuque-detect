(() => {
  const key = 'zhuque-site-theme';
  const system = matchMedia('(prefers-color-scheme: dark)');
  let mode = 'auto';
  try { const saved = localStorage.getItem(key); if (['light', 'dark'].includes(saved)) mode = saved; } catch { /* private browsing */ }
  function apply() {
    const actual = mode === 'auto' ? system.matches ? 'dark' : 'light' : mode;
    document.documentElement.dataset.theme = actual;
    document.documentElement.style.colorScheme = actual;
    const button = document.querySelector('#theme-toggle');
    if (button) {
      button.textContent = actual === 'dark' ? '☀' : '◐';
      button.setAttribute('aria-label', actual === 'dark' ? '切换到浅色主题' : '切换到深色主题');
      button.title = `${mode === 'auto' ? '跟随系统 · ' : ''}${actual === 'dark' ? '深色' : '浅色'}主题`;
      document.querySelector('#theme-auto').hidden = mode === 'auto';
    }
  }
  function save() { try { if (mode === 'auto') localStorage.removeItem(key); else localStorage.setItem(key, mode); } catch { /* optional persistence */ } apply(); }
  apply();
  system.addEventListener('change', () => { if (mode === 'auto') apply(); });
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelector('#theme-toggle').addEventListener('click', () => { mode = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; save(); });
    document.querySelector('#theme-auto').addEventListener('click', () => { mode = 'auto'; save(); });
    apply();
  });
})();
