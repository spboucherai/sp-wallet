export function applyTheme(t: 'light' | 'dark'): void {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'light' ? '#f3f4f7' : '#06080c');
}
