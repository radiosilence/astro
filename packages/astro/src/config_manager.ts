import type { ServerRuntime as SnowpackServerRuntime } from 'snowpack';
import type { AstroConfig } from './@types/astro';
import { posix as path } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import resolve from 'resolve';
import { loadConfig } from './config.js';

type RendererSnowpackPlugin = string | [string, any] | undefined;

interface RendererInstance {
  name: string;
  snowpackPlugin: RendererSnowpackPlugin;
  client: string;
  server: string;
  knownEntrypoints: string[] | undefined;
  jsxImportSource?: string;
}

const CONFIG_MODULE_BASE_NAME = '__astro_config.js';
const CONFIG_MODULE_URL = `/_astro_frontend/${CONFIG_MODULE_BASE_NAME}`;

const DEFAULT_RENDERERS = ['@astrojs/renderer-vue', '@astrojs/renderer-svelte', '@astrojs/renderer-react', '@astrojs/renderer-preact'];

export class ConfigManager {
  private state: 'initial' | 'dirty' | 'clean' = 'initial';
  public snowpackRuntime: SnowpackServerRuntime | null = null;
  public configModuleId: string | null = null;
  private rendererNames!: string[];
  private version = 1;

  constructor(private astroConfig: AstroConfig, private resolvePackageUrl: (pkgName: string) => Promise<string>) {
    this.setRendererNames(this.astroConfig);
  }

  markDirty() {
    this.state = 'dirty';
  }

  async update() {
    if (this.needsUpdate() && this.snowpackRuntime) {
      // astro.config.mjs has changed, reload it.
      if (this.state === 'dirty') {
        const version = this.version++;
        const astroConfig = await loadConfig(this.astroConfig.projectRoot.pathname, `astro.config.mjs?version=${version}`);
        this.setRendererNames(astroConfig);
      }

      await this.importModule(this.snowpackRuntime);
      this.state = 'clean';
    }
  }

  isConfigModule(fileExt: string, filename: string) {
    return fileExt === '.js' && filename.endsWith(CONFIG_MODULE_BASE_NAME);
  }

  isAstroConfig(filename: string) {
    const { projectRoot } = this.astroConfig;
    return new URL('./astro.config.mjs', projectRoot).pathname === filename;
  }

  async buildRendererInstances(): Promise<RendererInstance[]> {
    const { projectRoot } = this.astroConfig;
    const rendererNames = this.rendererNames;
    const resolveDependency = (dep: string) => resolve.sync(dep, { basedir: fileURLToPath(projectRoot) });

    const rendererInstances = (
      await Promise.all(
        rendererNames.map((rendererName) => {
          const entrypoint = pathToFileURL(resolveDependency(rendererName)).toString();
          return import(entrypoint);
        })
      )
    ).map(({ default: raw }, i) => {
      const { name = rendererNames[i], client, server, snowpackPlugin: snowpackPluginName, snowpackPluginOptions } = raw;

      if (typeof client !== 'string') {
        throw new Error(`Expected "client" from ${name} to be a relative path to the client-side renderer!`);
      }

      if (typeof server !== 'string') {
        throw new Error(`Expected "server" from ${name} to be a relative path to the server-side renderer!`);
      }

      let snowpackPlugin: RendererSnowpackPlugin;
      if (typeof snowpackPluginName === 'string') {
        if (snowpackPluginOptions) {
          snowpackPlugin = [resolveDependency(snowpackPluginName), snowpackPluginOptions];
        } else {
          snowpackPlugin = resolveDependency(snowpackPluginName);
        }
      } else if (snowpackPluginName) {
        throw new Error(`Expected the snowpackPlugin from ${name} to be a "string" but encountered "${typeof snowpackPluginName}"!`);
      }

      return {
        name,
        snowpackPlugin,
        client: path.join(name, raw.client),
        server: path.join(name, raw.server),
        knownEntrypoints: raw.knownEntrypoints,
        jsxImportSource: raw.jsxImportSource
      };
    });

    return rendererInstances;
  }

  async getRenderers(): Promise<RendererInstance[]> {
    const renderers = await this.buildRendererInstances();
    return renderers;
  }

  async buildSource(contents: string): Promise<string> {
    const renderers = await this.buildRendererInstances();
    const rendererServerPackages = renderers.map(({ server }) => server);
    const rendererClientPackages = await Promise.all(renderers.map(({ client }) => this.resolvePackageUrl(client)));
    const result = /* js */ `${rendererServerPackages.map((pkg, i) => `import __renderer_${i} from "${pkg}";`).join('\n')}

import { setRenderers } from 'astro/dist/internal/__astro_component.js';

let rendererSources = [${rendererClientPackages.map((pkg) => `"${pkg}"`).join(', ')}];
let renderers = [${rendererServerPackages.map((_, i) => `__renderer_${i}`).join(', ')}];

${contents}
`;
    return result;
  }

  needsUpdate(): boolean {
    return this.state === 'initial' || this.state === 'dirty';
  }

  private setRendererNames(astroConfig: AstroConfig) {
    this.rendererNames = astroConfig.renderers || DEFAULT_RENDERERS;
  }

  private async importModule(snowpackRuntime: SnowpackServerRuntime): Promise<void> {
    await snowpackRuntime!.importModule(CONFIG_MODULE_URL);
  }
}
