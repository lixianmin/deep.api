export function mountLog(pane: HTMLElement): () => void {
  pane.innerHTML = '<h2>日志（待 Task 6 实现）</h2>';
  return () => { pane.innerHTML = ''; };
}
