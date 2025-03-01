import type { Renderer } from '../@types/astro';
import hash from 'shorthash';
import { valueToEstree, Value } from 'estree-util-value-to-estree';
import { generate } from 'astring';
import * as astro from './renderer-astro';
import * as astroHtml from './renderer-html';

// A more robust version alternative to `JSON.stringify` that can handle most values
// see https://github.com/remcohaszing/estree-util-value-to-estree#readme
const serialize = (value: Value) => generate(valueToEstree(value));

export interface RendererInstance {
  source: string | null;
  renderer: Renderer;
  options: any;
  polyfills: string[];
}

const astroRendererInstance: RendererInstance = {
  source: '',
  renderer: astro as Renderer,
  options: null,
  polyfills: []
};

const astroHtmlRendererInstance: RendererInstance = {
  source: '',
  renderer: astroHtml as Renderer,
  options: null,
  polyfills: []
};

let rendererInstances: RendererInstance[] = [];

export function setRenderers(_rendererInstances: RendererInstance[]) {
  rendererInstances = [astroRendererInstance].concat(_rendererInstances);
}

function isCustomElementTag(name: string | Function) {
  return typeof name === 'string' && /-/.test(name);
}

const rendererCache = new Map<any, RendererInstance>();

/** For a given component, resolve the renderer. Results are cached if this instance is encountered again */
async function resolveRenderer(Component: any, props: any = {}, children?: string): Promise<RendererInstance | undefined> {
  if (rendererCache.has(Component)) {
    return rendererCache.get(Component)!;
  }

  const errors: Error[] = [];
  for (const instance of rendererInstances) {
    const { renderer, options } = instance;

    // Yes, we do want to `await` inside of this loop!
    // __renderer.check can't be run in parallel, it
    // returns the first match and skips any subsequent checks
    try {
      const shouldUse: boolean = await renderer.check(Component, props, children, options);

      if (shouldUse) {
        rendererCache.set(Component, instance);
        return instance;
      }
    } catch (err) {
      errors.push(err);
    }
  }

  if (errors.length) {
    // For now just throw the first error we encounter.
    throw errors[0];
  }
}

export interface AstroComponentProps {
  displayName: string;
  hydrate?: 'load' | 'idle' | 'visible';
  componentUrl?: string;
  componentExport?: { value: string; namespace?: boolean };
}

interface HydrateScriptOptions {
  instance: RendererInstance;
  astroId: string;
  props: any;
}

/** For hydrated components, generate a <script type="module"> to load the component */
async function generateHydrateScript({ instance, astroId, props }: HydrateScriptOptions, { hydrate, componentUrl, componentExport }: Required<AstroComponentProps>) {
  const { source } = instance;

  const hydrationSource = source ? `
  const [{ ${componentExport.value}: Component }, { default: hydrate }] = await Promise.all([import("${componentUrl}"), import("${source}")]);
  return (el, children) => hydrate(el)(Component, ${serialize(props)}, children);
`.trim() : `
  await import("${componentUrl}");
  return () => {};
`.trim()

  const hydrationScript = `<script type="module">
import setup from '/_astro_frontend/hydrate/${hydrate}.js';
setup("${astroId}", async () => {
  ${hydrationSource}
});
</script>`;

  return hydrationScript;
}

const getComponentName = (Component: any, componentProps: any) => {
  if (componentProps.displayName) return componentProps.displayName;
  switch (typeof Component) {
    case 'function':
      return Component.displayName ?? Component.name;
    case 'string':
      return Component;
    default: {
      return Component;
    }
  }
};

export const __astro_component = (Component: any, componentProps: AstroComponentProps = {} as any) => {
  if (Component == null) {
    throw new Error(`Unable to render ${componentProps.displayName} because it is ${Component}!\nDid you forget to import the component or is it possible there is a typo?`);
  } else if (typeof Component === 'string' && !isCustomElementTag(Component)) {
    throw new Error(`Astro is unable to render ${componentProps.displayName}!\nIs there a renderer to handle this type of component defined in your Astro config?`);
  }

  return async (props: any, ..._children: string[]) => {
    const children = _children.join('\n');
    let instance = await resolveRenderer(Component, props, children);

    if (!instance) {
      if(isCustomElementTag(Component)) {
        instance = astroHtmlRendererInstance;
      } else {
        // If the user only specifies a single renderer, but the check failed
        // for some reason... just default to their preferred renderer.
        instance = rendererInstances.length === 2 ? rendererInstances[1] : undefined;
      }

      if (!instance) {
        const name = getComponentName(Component, componentProps);
        throw new Error(`No renderer found for ${name}! Did you forget to add a renderer to your Astro config?`);
      }
    }
    let { html } = await instance.renderer.renderToStaticMarkup(Component, props, children, instance.options);

    if(instance.polyfills.length) {
      let polyfillScripts = instance.polyfills.map(src => `<script type="module" src="${src}"></script>`).join('');
      html = html + polyfillScripts;
    }

    // If we're NOT hydrating this component, just return the HTML
    if (!componentProps.hydrate) {
      // It's safe to remove <astro-fragment>, static content doesn't need the wrapper
      return html.replace(/\<\/?astro-fragment\>/g, '');
    }

    // If we ARE hydrating this component, let's generate the hydration script
    const astroId = hash.unique(html);
    const script = await generateHydrateScript({ instance, astroId, props }, componentProps as Required<AstroComponentProps>);
    const astroRoot = `<astro-root uid="${astroId}">${html}</astro-root>`;
    return [astroRoot, script].join('\n');
  };
};
