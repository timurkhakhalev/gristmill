#!/usr/bin/env node

const { buildMacosSwiftBinary } = require("./lib/build-macos-swift-binary");

buildMacosSwiftBinary({
  label: "meeting-ax",
  sourceName: "macos-meeting-ax.swift",
  binaryName: "macos-meeting-ax",
  frameworks: ["AppKit", "ApplicationServices", "CryptoKit"],
});
