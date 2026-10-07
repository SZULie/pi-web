import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT } = await jiti.import("./route.ts");

function put(body, headers = { host: "localhost", "Content-Type": "application/json" }) {
  return PUT(
    new Request("http://localhost/api/tools/overrides", {
      method: "PUT",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

test("tools overrides route supports GET and PUT updates", async () => {
  const getRes = await GET();
  assert.equal(getRes.status, 200);
  const initial = await getRes.json();
  assert.ok(typeof initial.overrides === "object");

  const testTool = `route-test-tool-${Date.now()}`;
  const override = {
    description: "Route test description",
    required: ["cmd", "timeout"],
    promptGuidelines: ["Always pass timeout."],
  };

  const putRes = await put({ toolName: testTool, override });
  assert.equal(putRes.status, 200);
  const putData = await putRes.json();
  assert.equal(putData.success, true);
  assert.deepEqual(putData.overrides[testTool], override);

  // Clean up
  const delRes = await put({ toolName: testTool, override: null });
  assert.equal(delRes.status, 200);
  const delData = await delRes.json();
  assert.equal(delData.overrides[testTool], undefined);
});
