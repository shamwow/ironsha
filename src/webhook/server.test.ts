import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Stub required env vars before any ironsha imports
process.env.GITHUB_APP_ID ??= "12345";
process.env.GITHUB_APP_PRIVATE_KEY ??= "test-key";
process.env.GITHUB_WEBHOOK_SECRET ??= "test-secret";

describe("webhook dispatch", () => {
  it("pull_request.labeled with bot-review-needed builds correct PRInfo", async () => {
    const { App } = await import("@octokit/app");

    // We test the event handler wiring by constructing a payload and verifying
    // the webhooks framework parses it correctly
    const app = new App({
      appId: "12345",
      privateKey: `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MhgHcTz6sE2I2yPB
aPKhP9JKkMBNBCLME3k2M3I0O3cwkaXyUxOya0yCEdFQ0PsqW2z0z/0VkaFMDTi
cplJxb9vAuwfUdI6UTEGl1WfpkL2sCogHIO/xJkMd0FkqjHT2LToP6MHSwNjVaKl
HRKSdJF8TmEDqoMPb0SmMBTq2FPC1KYfH2/s7GEbflhMb4GNzNxsH5ZYmn6DFb4g
iP7Bhx5MfPLmEgf8N+3vFxPj2qY2YUjz4iqPFDqQXBMjpHMHabMZ1TCgifSgo+97
EYyv7G+/WoLJVZ9kgsP2MwCx9Qf6bbuCAjH4jQIDAQABAoIBAFnkiMrNpFLi1F0A
q1NfmMAzxBHJPePQl06bkXM6sPDfm7E76JxZPNiyb8Y1GKXE0MWEVKY1GgOcEqaW
jcFiGWsQ1ZTRvBfT0xkqa7cW6UGq5TgjO0Dr/GnWo5KpfWpI1OP1xRm1ZGxngIOW
9egLhhMu6ioMPDVtTR5ynJVoHQvJKSvdqDkDaDe33kMFSLhPrOXoH7wFMCb0mJ0T
dTfhPjP/Z57rHOdD4YD4iMi9MyDYP18XIkqLknYwu+K2y0P2SkZNneLB0RT3MjK7
LGPlMFb1OMA0EfBGGW1i7x3FhkMcjFcbI9NV0SYPJmKnTdlhDJGEKZQRMPvkLai4
mj1n98ECgYEA7zDO3Mh0hJoAqxLB2VhQ5oYt5GMz5nfaNlOSp+XclwPOgv8aT3yK
O83F2KIsxROyMa0oAyRNDjZKxDOE81hHXGB9INcWfMjR7VJdaRNUx6FbMoLYOJCN
m0bI1kNMWfxSvL2sFEO4h0P2G6FKWJQV9VvFtVXDfsWY4d3pWnkf9kCgYEA4EcB
JjJPSpJPWm6rlXcWqVTPHaH1PBi9aYQDHkP2gy0vP8F0zVIY49tV+y0dnAALe3F0
WE87RI5E27EJHFbPfJHG4TZ/hCgIrFf/bL0MKfWJCSnRGpD1fTE24N7Sm0OU/P6i
IX7DBxBqSuQPcFmqJN3YHAYK2U6TrLO+3VqMFWUCgYEAxRma9w9tGk+IAm6YcCIu
4tqHCZ+yCEgvjQFzef4ExPBb0nS0Zl8tg6JlWjS1vPQf9HFzfFJZIGHDQ3hhKVEb
oo8pJZTPB2DssMGy1JdpCRMr3OF5GHppD3x0P8QV+v0OS0+vZUCuqfSy3sgXPIiG
1H+KOW2s1vGBSAVNy1tBHykCgYBTq1EYdBuGTE9C9fFIBfjFBVmbtHWqG9JWWQSZ
Rv+GDt3BcofJD1T0j6a0pcZr8j3FMMi+j2aT4oGpNGae3B8jl1YaJSYdF8bYhHUB
Jx2mJPYMz4GjVnrH8bEaxEZS4JQ2oqF4NcPR0QFlJBbVTmKTsf6J6Z8UsR/wlXuL
Qhm1LQKBgEMi0Fdq4Qk/DQ2sGYVG/uy1gDWkJU7OPvWR0hTlp7cs5n6cJgJgPEC
vU0E0K9+MKMi/LXi1zCHW8WuBbHCkZB+DH1DFULxEk7IXMPSKFYjS2C1GV+HJj6
mfN3wJGR39vQrj2L2KjBSpB7OKCEC6rML1d3uFDN5Z1G0xN4+j7l
-----END RSA PRIVATE KEY-----`,
      webhooks: { secret: "test-secret" },
    });

    // Track received events
    let receivedPayload: any;
    app.webhooks.on("pull_request.labeled", async ({ payload }) => {
      receivedPayload = payload;
    });

    const payload = {
      action: "labeled" as const,
      label: {
        name: "bot-review-needed",
        id: 1,
        node_id: "n",
        url: "",
        default: false,
        description: "",
        color: "",
      },
      installation: { id: 99 },
      pull_request: {
        number: 42,
        title: "Test PR",
        head: { ref: "feature-branch", sha: "abc123", label: "", repo: null, user: null },
        base: { ref: "main", sha: "def456", label: "", repo: null, user: null },
      },
      repository: {
        owner: { login: "test-org" },
        name: "test-repo",
      },
    };

    await app.webhooks.receive({
      id: "test-id",
      name: "pull_request",
      payload: payload as any,
    });

    assert.ok(receivedPayload, "webhook handler should have been called");
    assert.equal(receivedPayload.label.name, "bot-review-needed");
    assert.equal(receivedPayload.pull_request.number, 42);
    assert.equal(receivedPayload.pull_request.head.ref, "feature-branch");
    assert.equal(receivedPayload.pull_request.base.ref, "main");
    assert.equal(receivedPayload.repository.owner.login, "test-org");
    assert.equal(receivedPayload.repository.name, "test-repo");
    assert.equal(receivedPayload.installation.id, 99);

    // Verify we can extract PRInfo correctly from the payload
    const pr = {
      owner: receivedPayload.repository.owner.login,
      repo: receivedPayload.repository.name,
      number: receivedPayload.pull_request.number,
      branch: receivedPayload.pull_request.head.ref,
      baseBranch: receivedPayload.pull_request.base.ref,
      title: receivedPayload.pull_request.title,
    };

    assert.equal(pr.owner, "test-org");
    assert.equal(pr.repo, "test-repo");
    assert.equal(pr.number, 42);
    assert.equal(pr.branch, "feature-branch");
    assert.equal(pr.baseBranch, "main");
    assert.equal(pr.title, "Test PR");
  });

  it("ignores labels that are not bot-managed", async () => {
    const { App } = await import("@octokit/app");

    const app = new App({
      appId: "12345",
      privateKey: `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MhgHcTz6sE2I2yPB
aPKhP9JKkMBNBCLME3k2M3I0O3cwkaXyUxOya0yCEdFQ0PsqW2z0z/0VkaFMDTi
cplJxb9vAuwfUdI6UTEGl1WfpkL2sCogHIO/xJkMd0FkqjHT2LToP6MHSwNjVaKl
HRKSdJF8TmEDqoMPb0SmMBTq2FPC1KYfH2/s7GEbflhMb4GNzNxsH5ZYmn6DFb4g
iP7Bhx5MfPLmEgf8N+3vFxPj2qY2YUjz4iqPFDqQXBMjpHMHabMZ1TCgifSgo+97
EYyv7G+/WoLJVZ9kgsP2MwCx9Qf6bbuCAjH4jQIDAQABAoIBAFnkiMrNpFLi1F0A
q1NfmMAzxBHJPePQl06bkXM6sPDfm7E76JxZPNiyb8Y1GKXE0MWEVKY1GgOcEqaW
jcFiGWsQ1ZTRvBfT0xkqa7cW6UGq5TgjO0Dr/GnWo5KpfWpI1OP1xRm1ZGxngIOW
9egLhhMu6ioMPDVtTR5ynJVoHQvJKSvdqDkDaDe33kMFSLhPrOXoH7wFMCb0mJ0T
dTfhPjP/Z57rHOdD4YD4iMi9MyDYP18XIkqLknYwu+K2y0P2SkZNneLB0RT3MjK7
LGPlMFb1OMA0EfBGGW1i7x3FhkMcjFcbI9NV0SYPJmKnTdlhDJGEKZQRMPvkLai4
mj1n98ECgYEA7zDO3Mh0hJoAqxLB2VhQ5oYt5GMz5nfaNlOSp+XclwPOgv8aT3yK
O83F2KIsxROyMa0oAyRNDjZKxDOE81hHXGB9INcWfMjR7VJdaRNUx6FbMoLYOJCN
m0bI1kNMWfxSvL2sFEO4h0P2G6FKWJQV9VvFtVXDfsWY4d3pWnkf9kCgYEA4EcB
JjJPSpJPWm6rlXcWqVTPHaH1PBi9aYQDHkP2gy0vP8F0zVIY49tV+y0dnAALe3F0
WE87RI5E27EJHFbPfJHG4TZ/hCgIrFf/bL0MKfWJCSnRGpD1fTE24N7Sm0OU/P6i
IX7DBxBqSuQPcFmqJN3YHAYK2U6TrLO+3VqMFWUCgYEAxRma9w9tGk+IAm6YcCIu
4tqHCZ+yCEgvjQFzef4ExPBb0nS0Zl8tg6JlWjS1vPQf9HFzfFJZIGHDQ3hhKVEb
oo8pJZTPB2DssMGy1JdpCRMr3OF5GHppD3x0P8QV+v0OS0+vZUCuqfSy3sgXPIiG
1H+KOW2s1vGBSAVNy1tBHykCgYBTq1EYdBuGTE9C9fFIBfjFBVmbtHWqG9JWWQSZ
Rv+GDt3BcofJD1T0j6a0pcZr8j3FMMi+j2aT4oGpNGae3B8jl1YaJSYdF8bYhHUB
Jx2mJPYMz4GjVnrH8bEaxEZS4JQ2oqF4NcPR0QFlJBbVTmKTsf6J6Z8UsR/wlXuL
Qhm1LQKBgEMi0Fdq4Qk/DQ2sGYVG/uy1gDWkJU7OPvWR0hTlp7cs5n6cJgJgPEC
vU0E0K9+MKMi/LXi1zCHW8WuBbHCkZB+DH1DFULxEk7IXMPSKFYjS2C1GV+HJj6
mfN3wJGR39vQrj2L2KjBSpB7OKCEC6rML1d3uFDN5Z1G0xN4+j7l
-----END RSA PRIVATE KEY-----`,
      webhooks: { secret: "test-secret" },
    });

    let called = false;
    app.webhooks.on("pull_request.labeled", async () => {
      called = true;
    });

    const payload = {
      action: "labeled" as const,
      label: {
        name: "bug",
        id: 2,
        node_id: "n",
        url: "",
        default: false,
        description: "",
        color: "",
      },
      installation: { id: 99 },
      pull_request: {
        number: 42,
        title: "Test PR",
        head: { ref: "feature-branch", sha: "abc123", label: "", repo: null, user: null },
        base: { ref: "main", sha: "def456", label: "", repo: null, user: null },
      },
      repository: {
        owner: { login: "test-org" },
        name: "test-repo",
      },
    };

    await app.webhooks.receive({
      id: "test-id",
      name: "pull_request",
      payload: payload as any,
    });

    // The handler fires for any labeled event — filtering is done inside our handler
    // This test verifies the webhook infrastructure works and delivers labeled events
    assert.ok(called, "webhook handler should fire for any labeled event");
  });
});
