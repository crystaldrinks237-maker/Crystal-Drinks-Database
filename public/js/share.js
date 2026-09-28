// Buttons with data-share-pdf="URL" (and data-share-title, data-share-text):
// on a phone this opens the share sheet with the real PDF attached (choose WhatsApp there).
// Where file sharing isn't supported (most desktops) it simply downloads the PDF.
document.addEventListener('click', async function (ev) {
  const btn = ev.target.closest('[data-share-pdf]');
  if (!btn) return;
  ev.preventDefault();
  const url = btn.dataset.sharePdf;
  const original = btn.textContent;
  btn.textContent = 'Preparing...';
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('bad response');
    const blob = await res.blob();
    const match = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '');
    const name = match ? match[1] : 'document.pdf';
    const file = new File([blob], name, { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: btn.dataset.shareTitle || name, text: btn.dataset.shareText || '' });
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }
  } catch (e) {
    if (e && e.name !== 'AbortError') window.location.href = url; // fall back to a normal download
  } finally {
    btn.textContent = original;
  }
});
