#!/usr/bin/env node
// Resolves the launch path "/" against the real route files with expo-router's own resolver.
// native-v0.1.0 shipped a scaffold `src/app/index.tsx` that owned "/" and rendered a bare stub —
// a black screen on a dark phone. This fails the test suite if "/" ever stops landing on
// `(main)/index` (the home behind the login guard). Run: node scripts/check-routes.cjs
const Module = require("node:module");
const path = require("node:path");
const fs = require("node:fs");

// expo-router's path resolver imports @react-navigation/native (→ react-native); not needed here.
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (/react-navigation\/native$/.test(request)) return path.join(__dirname, "check-routes-stub.cjs");
  return resolve.call(this, request, ...rest);
};
fs.writeFileSync(path.join(__dirname, "check-routes-stub.cjs"), "exports.validatePathConfig = () => {};\n");

const base = path.join(__dirname, "..", "node_modules", "expo-router", "build");
const { getRoutes } = require(path.join(base, "getRoutes"));
const { getReactNavigationConfig } = require(path.join(base, "getReactNavigationConfig"));
const { getStateFromPath } = require(path.join(base, "fork", "getStateFromPath"));

function routeFiles(dir, root = dir) {
  return fs.readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) return routeFiles(p, root);
    return /\.tsx?$/.test(name) ? [`./${path.relative(root, p)}`] : [];
  });
}
function landing(files) {
  const ctx = Object.assign(() => ({ default: () => null }), { keys: () => files });
  const routes = getRoutes(ctx, { internal_stripLoadRoute: false, skipGenerated: true, importMode: "sync", platform: "android" });
  let s = getStateFromPath("/", getReactNavigationConfig(routes, false));
  const names = [];
  while (s) {
    const r = s.routes[s.index ?? s.routes.length - 1];
    names.push(r.name);
    s = r.state;
  }
  return names.join(" > ");
}

const files = routeFiles(path.join(__dirname, "..", "src", "app"));
const actual = landing(files);
const withStub = landing([...files, "./index.tsx"]);
fs.unlinkSync(path.join(__dirname, "check-routes-stub.cjs"));
console.log(`"/" opens: ${actual}   (with a root index.tsx it would open: ${withStub})`);
if (actual !== "(main) > index") {
  console.error('check-routes: "/" must open "(main) > index"');
  process.exit(1);
}
