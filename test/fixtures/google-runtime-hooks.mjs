export async function resolve(specifier, context, nextResolve) {
  if (
    specifier === "./google-runtime.js" &&
    context.parentURL?.endsWith("/dist/cli.js")
  ) {
    return {
      url: new URL("./google-runtime-fixture.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  }

  return nextResolve(specifier, context);
}
