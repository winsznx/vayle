import { writeFileSync } from "node:fs";
import { CARDS, renderCard } from "../social/cards.ts";

// Writes the brand's social card, the landing page's link preview, from the same card the web
// build renders for every page.
//   node scripts/render-social.ts

const landing = CARDS.find((c) => c.key === "landing");
if (landing === undefined) throw new Error("social/cards.ts has no landing card");
const png = await renderCard(landing);
writeFileSync(new URL("../social/vayle-og-1200x630.png", import.meta.url), png);
console.log(`wrote social/vayle-og-1200x630.png (${png.length.toString()} bytes)`);
