// Runs the dashboard's own scripts (assets/app-*.js, in the order index.html loads them) in a vm
// context, the way the browser runs them: classic scripts sharing one global scope.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function appScripts() {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const names = [...html.matchAll(/<script src="\/dashboard\/assets\/(app-[a-z-]+\.js)"><\/script>/g)].map((m) => m[1]);
  assert.ok(names.length >= 1, "Expected app scripts in index.html");
  return names.map((name) => {
    const filename = path.join("dashboard", "assets", name);
    const code = fs.readFileSync(path.join(__dirname, "assets", name), "utf8");
    return new vm.Script(code, { filename }); // compiling first reports syntax errors per file
  });
}

// Run every app script in the context, then `tail` (an expression or statement reading their globals).
function runAppScripts(sandbox, tail = "") {
  vm.createContext(sandbox);
  for (const script of appScripts()) script.runInContext(sandbox);
  return tail ? vm.runInContext(tail, sandbox) : undefined;
}

module.exports = { runAppScripts };
