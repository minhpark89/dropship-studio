import test from "node:test";
import assert from "node:assert/strict";
import { parseWikimediaImages, searchImageQueries, isPublicImageUrl,newsImageCandidates } from "../server/image-search.js";

const response = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

test("Wikimedia image parsing keeps public URLs, attribution and bounded results", () => {
  const images = parseWikimediaImages({
    query: {
      pages: {
        1: {
          pageid: 1,
          title: "File:AI studio.jpg",
          canonicalurl: "https://commons.wikimedia.org/wiki/File:AI_studio.jpg",
          imageinfo: [{
            thumburl: "https://upload.wikimedia.org/example.jpg",
            width: 1600,
            height: 900,
            mime: "image/jpeg",
            extmetadata: { LicenseShortName: { value: "CC BY-SA" }, Artist: { value: "<b>Example</b>" } },
          }],
        },
      },
    },
  }, "AI video", 1);
  assert.equal(images.length, 1);
  assert.equal(images[0].title, "AI studio.jpg");
  assert.equal(images[0].license, "CC BY-SA");
  assert.equal(images[0].attribution, "Example");
  assert.equal(isPublicImageUrl(images[0].imageUrl), true);
});

test("image query search deduplicates results and reports failed queries", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("broken")) return new Response("offline", { status: 503 });
    return response({ query: { pages: { 1: { pageid: 1, title: "File:Shared.jpg", imageinfo: [{ thumburl: "https://upload.wikimedia.org/shared.jpg", mime: "image/jpeg" }] } } } });
  };
  const result = await searchImageQueries(["AI video", "AI video", "broken"], { fetchImpl, maxResultsPerQuery: 2 });
  assert.equal(result.images.length, 1);
  assert.equal(result.warnings.length, 1);
  assert.equal(calls.length, 2);
});

test("private and non-http image URLs are rejected before download", () => {
  assert.equal(isPublicImageUrl("http://127.0.0.1/image.jpg"), false);
  assert.equal(isPublicImageUrl("file:///C:/secret.jpg"), false);
  assert.equal(isPublicImageUrl("https://upload.wikimedia.org/image.jpg"), true);
});

test("news image selection prioritizes the article photograph and rejects PDF previews, stamps and logos",()=>{
  const images=[{title:"Congress report.pdf",mime:"application/pdf",imageUrl:"https://example.com/report.pdf.jpg"},{title:"Stamp of Moldova.jpeg",mime:"image/jpeg",imageUrl:"https://example.com/stamp.jpg"},{title:"Logo.svg",mime:"image/svg+xml",imageUrl:"https://example.com/logo.svg"},{title:"Starlink dish.jpg",mime:"image/jpeg",imageUrl:"https://example.com/dish.jpg"}];
  const selected=newsImageCandidates([{id:"source",title:"Starlink news",source:"BBC",url:"https://bbc.co.uk/news/report",imageUrl:"https://ichef.bbci.co.uk/ace/standard/240/photo.jpg"}],images);
  assert.equal(selected.length,2);
  assert.equal(selected[0].imageUrl,"https://ichef.bbci.co.uk/ace/standard/1280/photo.jpg");
  assert.equal(selected[1].title,"Starlink dish.jpg");
});
