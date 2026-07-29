/** Scratch probe: does the capacity stepper actually issue POSTs? */
import {
  createRoomAsHost,
  knockAndAdmit,
  launchMeshBrowser,
  newParticipant,
  openSettings,
  wait,
} from "./mesh-shared.mjs";

const BASE = "http://127.0.0.1:3111";
const browser = await launchMeshBrowser({});
const host = await newParticipant(browser, "Hana", { name: "Hana" });
const guest = await newParticipant(browser, "Bela", { name: "Bela" });

await host.context.route("**/api/signal/**", async (route) => {
  const request = route.request();
  if (request.method() === "POST") {
    const body = request.postData() ?? "";
    if (body.includes('"capacity"') || body.includes('"t":"capacity"')) {
      console.log(`POST capacity: ${body}`);
    }
  }
  await route.fallback();
});

const roomUrl = await createRoomAsHost(host, BASE);
console.log("room created; lobby dismissed");
await knockAndAdmit(host, guest, roomUrl);
console.log("guest admitted");

const opened = await openSettings(host.page);
console.log(`settings tab opened: ${opened}`);
const group = host.page.locator('[role="group"][aria-label="Participant limit" i]').first();
console.log(`group visible: ${await group.isVisible().catch(() => false)}`);
console.log(`group text: ${await group.innerText().catch(() => "n/a")}`);

const raise = host.page.getByRole("button", { name: /raise the participant limit/i }).first();
console.log(`raise visible: ${await raise.isVisible().catch(() => false)}`);
console.log(`raise enabled: ${await raise.isEnabled().catch(() => "n/a")}`);
try {
  await raise.click({ timeout: 5000 });
  console.log("raise clicked");
} catch (error) {
  console.log(`raise click FAILED: ${error.message.split("\n")[0]}`);
}
await wait(2000);
console.log(`group text after: ${await group.innerText().catch(() => "n/a")}`);
await browser.close();
