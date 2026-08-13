interface NativeTypeScriptProof {
  readonly message: string;
}

const proof: NativeTypeScriptProof = { message: "native-typescript-ok" };
if (process.env.NODE_TEST_CONTEXT === undefined) {
  process.stdout.write(`${proof.message}\n`);
}
