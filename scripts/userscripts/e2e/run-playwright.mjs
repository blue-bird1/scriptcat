import { spawn } from "node:child_process";

const userArguments = process.argv.slice(2);
if (userArguments[0] === "--") userArguments.shift();

const child = spawn(
  "pnpm",
  ["exec", "playwright", "test", "--config=playwright.userscripts.config.mjs", ...userArguments],
  { stdio: "inherit" },
);

child.once("error", (error) => {
  console.error(`Unable to start Playwright with pnpm: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`Playwright stopped by ${signal}.`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
