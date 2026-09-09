export function mountRouting(pane: HTMLElement): () => void {
  pane.innerHTML = '<h2>路由（待 Task 5 实现）</h2>';
  return () => { pane.innerHTML = ''; };
}
