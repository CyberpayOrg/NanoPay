import { CompilerConfig } from "@ton/blueprint";

export const compile: CompilerConfig = {
  lang: "tact",
  target: "contracts/cyber_gateway.tact",
  options: {
    debug: true,
  },
};
