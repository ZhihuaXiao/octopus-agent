/**
 * What `npm run octo` starts: octo, given back the web flags npm kept for
 * itself when they were written without a `--` before them.
 */
import { NPM_WEB_CONFIG, fromNpm } from "./npm.js";

process.argv = [...process.argv.slice(0, 2), ...fromNpm(process.argv.slice(2), process.env)];
// A Bash Cell that runs `npm run octo` again would otherwise inherit these,
// and be read as asking for the web interface too.
for (const name of Object.values(NPM_WEB_CONFIG)) delete process.env[name];

await import("./octo.js");
