import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(
  fileURLToPath(import.meta.resolve("expo-modules-jsi/package.json")),
);
const sourcePath = path.join(
  packageRoot,
  "apple",
  "Sources",
  "ExpoModulesJSI",
  "Runtime",
  "JavaScriptRuntime.swift",
);

const source = fs.readFileSync(sourcePath, "utf8");

if (source.includes("    let setterPointer:\n")) {
  process.stdout.write(
    "ExpoModulesJSI already contains the Xcode 27 setter-pointer fix.\n",
  );
  process.exit(0);
}

const before = `    // Pass a null setter to C++ when the Swift setter is nil so that JS assignment
    // raises a \`jsi::JSError\` directly, without crossing the Swift boundary.
    let callbacks = expo.HostObjectCallbacks(
      context, getter, set == nil ? nil : setter, propertyNamesGetter, deallocate)`;

const after = `    // Backported from ExpoModulesJSI 57 for Xcode 27's stricter Swift compiler.
    // An explicitly typed C function pointer is required before it can be used
    // in the optional expression below.
    let setterPointer:
      (@convention(c) (UnsafeMutableRawPointer, UnsafePointer<CChar>, UnsafeMutableRawPointer) -> Void)? = setter
    // Pass a null setter to C++ when the Swift setter is nil so that JS assignment
    // raises a \`jsi::JSError\` directly, without crossing the Swift boundary.
    let callbacks = expo.HostObjectCallbacks(
      context, getter, set == nil ? nil : setterPointer, propertyNamesGetter, deallocate)`;

if (!source.includes(before)) {
  throw new Error(
    "ExpoModulesJSI changed and the Xcode 27 compatibility patch could not be applied. " +
      "Check whether the installed version already includes the upstream setterPointer fix.",
  );
}

fs.writeFileSync(sourcePath, source.replace(before, after));
process.stdout.write("Applied the ExpoModulesJSI Xcode 27 setter-pointer fix.\n");
