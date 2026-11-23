import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/register-ts-hooks.mjs";

const { AwsMicroVmClient } = await import("../src/aws-microvm.ts");
const { AwsClient } = await import("aws4fetch");

const BASE_ENV = {
  AWS_REGION: "ap-northeast-1",
  AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
  AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

test("AwsMicroVmClient passes sessionToken when AWS_SESSION_TOKEN is set", () => {
  new AwsMicroVmClient({ ...BASE_ENV, AWS_SESSION_TOKEN: "session-token-example" });

  assert.deepEqual(AwsClient.lastOptions, {
    accessKeyId: BASE_ENV.AWS_ACCESS_KEY_ID,
    secretAccessKey: BASE_ENV.AWS_SECRET_ACCESS_KEY,
    sessionToken: "session-token-example",
    region: "ap-northeast-1",
    service: "lambda",
  });
});

test("AwsMicroVmClient omits sessionToken when AWS_SESSION_TOKEN is unset or empty", () => {
  for (const env of [BASE_ENV, { ...BASE_ENV, AWS_SESSION_TOKEN: "" }]) {
    new AwsMicroVmClient(env);
    assert.equal(AwsClient.lastOptions.sessionToken, undefined);
    assert.equal(AwsClient.lastOptions.accessKeyId, BASE_ENV.AWS_ACCESS_KEY_ID);
  }
});
