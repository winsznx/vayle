// Whether this visitor may place new orders where they are. The site's Worker decides it from the
// country Cloudflare finds for the request and writes the answer into the page. A page served
// without the Worker, on a dev server, carries no answer and isn't restricted.
export function placementRestricted(): boolean {
  return (
    document.querySelector('meta[name="vayle-region"]')?.getAttribute("content") === "restricted"
  );
}
