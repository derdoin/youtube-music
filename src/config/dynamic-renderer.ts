import defaultConfig from './defaults';

import { Entries } from '../utils/type-utils';

import type { OneOfDefaultConfigKey, ConfigType, PluginConfigOptions } from './dynamic';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const activePlugins: { [key in OneOfDefaultConfigKey]?: PluginConfig<any> } = {};

export const getActivePlugins
  = async () => await window.ipcRenderer.invoke('get-active-plugins') as Promise<typeof activePlugins>;

export const isActive
  = async (plugin: string) => plugin in (await window.ipcRenderer.invoke('get-active-plugins'));

/**
 * This class is used to create a dynamic synced config for plugins.
 *
 * @param {string} name - The name of the plugin.
 * @param {boolean} [options.enableFront] - Whether the config should be available in front.js. Default: false.
 * @param {object} [options.initialOptions] - The initial options for the plugin. Default: loaded from store.
 *
 * @example
 * const { PluginConfig } = require("../../config/dynamic-renderer");
 * const config = new PluginConfig("plugin-name", { enableFront: true });
 * module.exports = { ...config };
 *
 * // or
 *
 * module.exports = (win, options) => {
 *  const config = new PluginConfig("plugin-name", {
 *    enableFront: true,
 *    initialOptions: options,
 *  });
 *  setupMyPlugin(win, config);
 * };
 */
type ValueOf<T> = T[keyof T];

export class PluginConfig<T extends OneOfDefaultConfigKey> {
  private readonly name: string;
  private readonly config: ConfigType<T>;
  private readonly defaultConfig: ConfigType<T>;
  private readonly enableFront: boolean;

  private subscribers: { [key in keyof ConfigType<T>]?: (config: ConfigType<T>) => void } = {};
  private allSubscribers: ((config: ConfigType<T>) => void)[] = [];

  constructor(
    name: T,
    options: PluginConfigOptions = {
      enableFront: false,
    },
  ) {
    const pluginDefaultConfig = defaultConfig.plugins[name] ?? {};
    const pluginConfig = options.initialOptions || window.mainConfig.plugins.getOptions(name) || {};

    this.name = name;
    this.enableFront = options.enableFront;
    this.defaultConfig = pluginDefaultConfig;
    this.config = { ...pluginDefaultConfig, ...pluginConfig };

    if (this.enableFront) {
      this.setupFront();
    }

    activePlugins[name] = this;
  }

  get<Key extends keyof ConfigType<T> = keyof ConfigType<T>>(key: Key): ConfigType<T>[Key] {
    return this.config?.[key];
  }

  set(key: keyof ConfigType<T>, value: ValueOf<ConfigType<T>>) {
    this.config[key] = value;
    this.onChange(key);
    this.save();
  }

  getAll(): ConfigType<T> {
    return { ...this.config };
  }

  setAll(options: Partial<ConfigType<T>>) {
    if (!options || typeof options !== 'object') {
      throw new Error('Options must be an object.');
    }

    let changed = false;
    for (const [key, value] of Object.entries(options) as Entries<typeof options>) {
      if (this.config[key] !== value) {
        if (value !== undefined) this.config[key] = value;
        this.onChange(key, false);
        changed = true;
      }
    }

    if (changed) {
      for (const fn of this.allSubscribers) {
        fn(this.config);
      }
    }

    this.save();
  }

  getDefaultConfig() {
    return this.defaultConfig;
  }

  /**
   * Use this method to set an option and restart the app if `appConfig.restartOnConfigChange === true`
   *
   * Used for options that require a restart to take effect.
   */
  setAndMaybeRestart(key: keyof ConfigType<T>, value: ValueOf<ConfigType<T>>) {
    this.config[key] = value;
    window.mainConfig.plugins.setMenuOptions(this.name, this.config);
    this.onChange(key);
  }

  subscribe(valueName: keyof ConfigType<T>, fn: (config: ConfigType<T>) => void) {
    this.subscribers[valueName] = fn;
  }

  subscribeAll(fn: (config: ConfigType<T>) => void) {
    this.allSubscribers.push(fn);
  }

  /** Called only from back */
  private save() {
    window.mainConfig.plugins.setOptions(this.name, this.config);
  }

  private onChange(valueName: keyof ConfigType<T>, single: boolean = true) {
    this.subscribers[valueName]?.(this.config[valueName] as ConfigType<T>);
    if (single) {
      for (const fn of this.allSubscribers) {
        fn(this.config);
      }
    }
  }

  private setupFront() {
    const ignoredMethods = ['subscribe', 'subscribeAll'];

    for (const [fnName, fn] of Object.entries(this) as Entries<this>) {
      if (typeof fn !== 'function' || fn.name in ignoredMethods) {
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any,@typescript-eslint/no-unsafe-return
      this[fnName] = (async (...args: any) => await window.ipcRenderer.invoke(
        `${this.name}-config-${String(fnName)}`,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        ...args,
      )) as typeof this[keyof this];

      this.subscribe = (valueName, fn: (config: ConfigType<T>) => void) => {
        if (valueName in this.subscribers) {
          console.error(`Already subscribed to ${String(valueName)}`);
        }

        this.subscribers[valueName] = fn;
        window.ipcRenderer.on(
          `${this.name}-config-changed-${String(valueName)}`,
          (_, value: ConfigType<T>) => {
            fn(value);
          },
        );
        window.ipcRenderer.send(`${this.name}-config-subscribe`, valueName);
      };

      this.subscribeAll = (fn: (config: ConfigType<T>) => void) => {
        window.ipcRenderer.on(`${this.name}-config-changed`, (_, value: ConfigType<T>) => {
          fn(value);
        });
        window.ipcRenderer.send(`${this.name}-config-subscribe-all`);
      };
    }
  }
}
