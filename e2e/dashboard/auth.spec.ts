import { expect, test } from "@playwright/test";
import { FAKE_TOKEN, SESSION, UNAUTHENTICATED, mockApi, reply } from "./api-mock.js";

test("signs in, shows the café and signs out", async ({ page }) => {
  let signedIn = false;
  await mockApi(page, {
    "GET /api/auth/session": (route) => (signedIn ? route.fulfill({ json: SESSION }) : route.fulfill({ status: 401, json: UNAUTHENTICATED })),
    "POST /api/auth/login": async (route) => {
      expect(route.request().postDataJSON()).toEqual({ email: "rana@example.com", password: "correct horse battery" });
      signedIn = true;
      await route.fulfill({ json: SESSION });
    },
    "POST /api/auth/logout": async (route) => {
      signedIn = false;
      await route.fulfill({ status: 204 });
    },
  });
  await page.goto("/");
  await page.getByLabel("Email").fill("rana@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Café Najjar" })).toBeVisible();
  await expect(page.getByText("Signed in as rana@example.com")).toBeVisible();

  await page.getByRole("navigation", { name: "Dashboard" }).getByRole("link", { name: "Account" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("status")).toHaveText("You signed out on every device.");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("signs in with the keyboard alone", async ({ page }) => {
  await mockApi(page, { "GET /api/auth/session": reply(401, UNAUTHENTICATED), "POST /api/auth/login": reply(200, SESSION) });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Email")).toBeFocused();
  await page.keyboard.type("rana@example.com");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Password")).toBeFocused();
  await page.keyboard.type("correct horse battery");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Café Najjar" })).toBeVisible();
});

test("shows why sign-in failed", async ({ page }) => {
  await mockApi(page, {
    "GET /api/auth/session": reply(401, UNAUTHENTICATED),
    "POST /api/auth/login": (route) =>
      route.fulfill({
        status: 429,
        headers: { "retry-after": "900" },
        json: { code: "RATE_LIMITED", message: "Too many attempts. Wait 15 minutes and try again.", retryable: true },
      }),
  });
  await page.goto("/");
  await page.getByLabel("Email").fill("rana@example.com");
  await page.getByLabel("Password").fill("wrong password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText("Too many attempts. Wait 15 minutes and try again.");
});

test("creates an account from an invite link", async ({ page }) => {
  let signedIn = false;
  await mockApi(page, {
    "GET /api/auth/session": (route) => (signedIn ? route.fulfill({ json: SESSION }) : route.fulfill({ status: 401, json: UNAUTHENTICATED })),
    "POST /api/auth/signup": async (route) => {
      expect(route.request().postDataJSON()).toEqual({ inviteToken: FAKE_TOKEN, email: "rana@example.com", password: "correct horse battery" });
      signedIn = true;
      await route.fulfill({ status: 201, json: SESSION });
    },
  });
  await page.goto(`/signup#invite=${FAKE_TOKEN}`);
  // The token leaves the address bar (and so the history) once read.
  await expect(page).toHaveURL(/\/signup$/);
  await page.getByLabel("Email").fill("rana@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Café Najjar" })).toBeVisible();
});

test("explains a used invite and a link without its token", async ({ page }) => {
  await mockApi(page, {
    "POST /api/auth/signup": reply(410, {
      code: "LINK_EXPIRED",
      message: "This invite link has expired or was already used. Ask for a new invite.",
      retryable: false,
    }),
  });
  await page.goto(`/signup#invite=${FAKE_TOKEN}`);
  await page.getByLabel("Email").fill("rana@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("alert")).toHaveText("This invite link has expired or was already used. Ask for a new invite.");

  for (const path of ["/signup", "/signup#invite=cut-short"]) {
    await page.goto(path);
    await expect(page.getByRole("alert")).toContainText("This invite link is incomplete.");
  }
});

test("requests a reset link and sets a new password from it", async ({ page }) => {
  const message = "If an account uses this email, we sent it a link to reset the password. The link works for 30 minutes.";
  await mockApi(page, {
    "POST /api/auth/password-reset": reply(202, { message }),
    "POST /api/auth/password-reset/complete": async (route) => {
      expect(route.request().postDataJSON()).toEqual({ token: FAKE_TOKEN, password: "a brand new password" });
      await route.fulfill({ status: 204 });
    },
  });
  await page.goto("/forgot-password");
  await page.getByLabel("Email").fill("rana@example.com");
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("status")).toHaveText(message);

  await page.goto(`/reset-password#token=${FAKE_TOKEN}`);
  await page.getByLabel("New password", { exact: true }).fill("a brand new password");
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(page.getByRole("status")).toHaveText("Your password is changed. Sign in with the new password.");
});

test("changes the password and returns to sign-in", async ({ page }) => {
  await mockApi(page, { "GET /api/auth/session": reply(200, SESSION), "POST /api/auth/password": reply(204) });
  await page.goto("/account");
  await page.getByLabel("Current password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("New password", { exact: true }).fill("a brand new password");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByRole("status")).toHaveText("Your password is changed. Sign in with the new password.");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("says so when the server cannot be reached", async ({ page }) => {
  await page.route("**/api/**", (route) => route.abort("internetdisconnected"));
  await page.goto("/");
  await expect(page.getByRole("alert")).toHaveText("Could not reach the server. Check your connection and try again.");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("treats a proxy's HTML error page as a retryable failure", async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ status: 502, contentType: "text/html", body: "<html>Bad Gateway</html>" }));
  await page.goto("/");
  await expect(page.getByRole("alert")).toHaveText("The server sent an unreadable response (HTTP 502). Wait a moment and try again.");
});

test("returns to sign-in when the session ended before a password change", async ({ page }) => {
  await mockApi(page, { "GET /api/auth/session": reply(200, SESSION), "POST /api/auth/password": reply(401, UNAUTHENTICATED) });
  await page.goto("/account");
  await page.getByLabel("Current password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("New password", { exact: true }).fill("a brand new password");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByRole("status")).toHaveText("Your session has ended. Sign in again.");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});
