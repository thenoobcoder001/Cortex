const { startBackendServer } = require("./server");

async function main() {
  const port = 8765;
  const host = "127.0.0.1";
  console.log(`Starting standalone backend on http://${host}:${port}...`);
  try {
    const handle = await startBackendServer({ host, port });
    console.log(`Backend is running at ${handle.url}`);
  } catch (error) {
    console.error("Failed to start backend:", error);
    process.exit(1);
  }
}

main();
