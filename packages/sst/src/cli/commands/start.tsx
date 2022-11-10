import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import { CloudAssembly } from "aws-cdk-lib/cx-api";
import { Program } from "../program.js";
import { useRuntimeWorkers } from "../../runtime/workers.js";
import { useIOTBridge } from "../../runtime/iot.js";
import { useRuntimeServer } from "../../runtime/server.js";
import { useMetadata } from "../../stacks/metadata.js";
import { useBus } from "../../bus.js";
import { useWatcher } from "../../watcher.js";
import { Stacks } from "../../stacks/index.js";
import { Logger } from "../../logger.js";
import { createSpinner } from "../spinner.js";
import { bold, magenta, green, blue, red } from "colorette";
import { render } from "ink";
import React from "react";
import { Context } from "../../context/context.js";
import { DeploymentUI } from "../ui/deploy.js";
import { Metafile } from "esbuild";
import { useFunctions } from "../../constructs/Function.js";

export const start = (program: Program) =>
  program.command(
    "start",
    "Work on your SST app locally",
    (yargs) => yargs,
    async () => {
      const functionSpinner = createSpinner(
        "Getting read for function invocations"
      ).start();
      await Promise.all([
        useRuntimeWorkers(),
        useIOTBridge(),
        useRuntimeServer(),
        useMetadata(),
        useFunctionLogger(),
      ]);
      functionSpinner.succeed("Ready for function invocations");
      await useStackBuilder();
    }
  );

const useFunctionLogger = Context.memo(async () => {
  const bus = useBus();

  bus.subscribe("function.invoked", async (evt) => {
    console.log(bold(magenta(`Invoked `)), bold(evt.properties.functionID));
  });

  bus.subscribe("worker.stdout", async (evt) => {
    console.log(
      bold(blue(`Log     `)),
      bold(evt.properties.functionID),
      evt.properties.message
    );
  });

  bus.subscribe("function.success", async (evt) => {
    console.log(bold(green(`Success `)), bold(evt.properties.functionID));
  });
});

const useStackBuilder = Context.memo(async () => {
  const watcher = useWatcher();
  const bus = useBus();

  let lastDeployed: string;
  let pending: CloudAssembly | undefined;
  let isDeploying = false;

  async function build() {
    const spinner = createSpinner("Building stacks").start();
    const fn = await Stacks.build();
    const assembly = await Stacks.synth({
      fn,
      outDir: `.sst/cdk.out`,
      mode: "start",
    });
    Logger.debug("Directory", assembly.directory);
    const next = await checksum(assembly.directory);
    Logger.debug("Checksum", "next", next, "old", lastDeployed);
    if (next === lastDeployed) {
      spinner.succeed("Stacks built! No changes");
      return;
    }
    spinner.succeed(lastDeployed ? `Stacks built!` : `Stacks built!`);
    pending = assembly;
    if (lastDeployed) deploy();
  }

  async function deploy() {
    if (!pending) return;
    if (isDeploying) return;
    isDeploying = true;
    const assembly = pending;
    const nextChecksum = await checksum(assembly.directory);
    pending = undefined;
    process.stdout.write("\x1b[?1049h");
    const component = render(
      <DeploymentUI stacks={assembly.stacks.map((s) => s.stackName)} />
    );
    const results = await Stacks.deployMany(assembly.stacks);
    component.unmount();
    process.stdout.write("\x1b[?1049l");
    lastDeployed = nextChecksum;
    console.log(`----------------------------`);
    console.log(`| Stack deployment results |`);
    console.log(`----------------------------`);
    for (const [stack, result] of Object.entries(results)) {
      const icon = (() => {
        if (Stacks.isSuccess(result.status)) return green("✔");
        if (Stacks.isFailed(result.status)) return red("✖");
      })();
      console.log(`${icon} ${stack}`);
      for (const [id, error] of Object.entries(result.errors)) {
        console.log(bold(`  ${id}: ${error}`));
      }
    }
    isDeploying = false;
    deploy();
  }

  async function checksum(cdkOutPath: string) {
    const manifestPath = path.join(cdkOutPath, "manifest.json");
    const cdkManifest = JSON.parse(
      await fs.readFile(manifestPath).then((x) => x.toString())
    );
    const checksumData = await Promise.all(
      Object.keys(cdkManifest.artifacts)
        .filter(
          (key: string) =>
            cdkManifest.artifacts[key].type === "aws:cloudformation:stack"
        )
        .map(async (key: string) => {
          const { templateFile } = cdkManifest.artifacts[key].properties;
          const templatePath = path.join(cdkOutPath, templateFile);
          const templateContent = await fs.readFile(templatePath);
          return templateContent;
        })
    ).then((x) => x.join("\n"));
    const hash = crypto.createHash("sha256").update(checksumData).digest("hex");
    return hash;
  }

  let metafile: Metafile;
  bus.subscribe("stack.built", async (evt) => {
    metafile = evt.properties.metafile;
  });

  watcher.subscribe("file.changed", async (evt) => {
    if (!metafile) return;
    if (!metafile.inputs[evt.properties.relative]) return;
    build();
  });

  await build();
  await deploy();
});