export function mountChat(pane: HTMLElement): () => void {
  pane.innerHTML = '<h2>Chat（待 Task 4 实现）</h2>';
  return () => { pane.innerHTML = ''; };
}
