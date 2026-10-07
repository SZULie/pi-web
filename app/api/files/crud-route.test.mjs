import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-files-crud-")));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST, DELETE } = await jiti.import("./[...path]/route.ts");
const { allowFileRoot } = await jiti.import("../../../lib/allowed-roots.ts");
allowFileRoot(root);

test("creates new file and folder, then deletes them", async () => {
  const dir = path.join(root, "project");
  fs.mkdirSync(dir, { recursive: true });

  const segments = dir.replace(/\\/g, "/").split("/").filter(Boolean);

  // 1. Create directory
  const createDirReq = new NextRequest("http://localhost/api/files/x?type=create-dir", {
    method: "POST",
    headers: { "Content-Type": "application/json", host: "localhost" },
    body: JSON.stringify({ name: "docs/subdir" }),
  });
  const createDirRes = await POST(createDirReq, { params: Promise.resolve({ path: segments }) });
  assert.equal(createDirRes.status, 200);
  assert.ok(fs.existsSync(path.join(dir, "docs/subdir")));

  // 2. Create file inside that directory
  const createFileReq = new NextRequest("http://localhost/api/files/x?type=create-file", {
    method: "POST",
    headers: { "Content-Type": "application/json", host: "localhost" },
    body: JSON.stringify({ name: "docs/subdir/hello.txt", content: "Hello world" }),
  });
  const createFileRes = await POST(createFileReq, { params: Promise.resolve({ path: segments }) });
  assert.equal(createFileRes.status, 200);
  assert.ok(fs.existsSync(path.join(dir, "docs/subdir/hello.txt")));
  assert.equal(fs.readFileSync(path.join(dir, "docs/subdir/hello.txt"), "utf8"), "Hello world");

  // 3. Delete file
  const fileSegments = path.join(dir, "docs/subdir/hello.txt").replace(/\\/g, "/").split("/").filter(Boolean);
  const deleteFileReq = new NextRequest("http://localhost/api/files/x", {
    method: "DELETE",
    headers: { host: "localhost" },
  });
  const deleteFileRes = await DELETE(deleteFileReq, { params: Promise.resolve({ path: fileSegments }) });
  assert.equal(deleteFileRes.status, 200);
  assert.ok(!fs.existsSync(path.join(dir, "docs/subdir/hello.txt")));

  // 4. Delete directory
  const dirSegments = path.join(dir, "docs").replace(/\\/g, "/").split("/").filter(Boolean);
  const deleteDirReq = new NextRequest("http://localhost/api/files/x", {
    method: "DELETE",
    headers: { host: "localhost" },
  });
  const deleteDirRes = await DELETE(deleteDirReq, { params: Promise.resolve({ path: dirSegments }) });
  assert.equal(deleteDirRes.status, 200);
  assert.ok(!fs.existsSync(path.join(dir, "docs")));
});

test("uploads files without 25MB or 100MB size limit", async () => {
  const dir = path.join(root, "project-upload");
  fs.mkdirSync(dir, { recursive: true });

  const segments = dir.replace(/\\/g, "/").split("/").filter(Boolean);

  // 26MB > 25MB
  const largeContent = Buffer.alloc(26 * 1024 * 1024, "a");
  const form = new FormData();
  form.append("files", new Blob([largeContent]), "large-dataset.bin");

  const uploadReq = new NextRequest("http://localhost/api/files/x?type=upload&conflict=overwrite", {
    method: "POST",
    headers: { host: "localhost" },
    body: form,
  });
  const uploadRes = await POST(uploadReq, { params: Promise.resolve({ path: segments }) });
  assert.equal(uploadRes.status, 200);
  const data = await uploadRes.json();
  assert.deepEqual(data.uploaded, ["large-dataset.bin"]);
  assert.ok(fs.existsSync(path.join(dir, "large-dataset.bin")));
  assert.equal(fs.statSync(path.join(dir, "large-dataset.bin")).size, 26 * 1024 * 1024);
});
