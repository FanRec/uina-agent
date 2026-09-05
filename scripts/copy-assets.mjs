import { cp, mkdir } from "node:fs/promises";
const destination = new URL("../dist/src/ui/core/native/", import.meta.url);
await mkdir(destination, { recursive: true });
await cp(new URL("../src/ui/core/native/", import.meta.url), destination, { recursive: true });
