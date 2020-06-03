/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as debugUtils from './utils';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { BuildTaskDefinition } from '../LanguageServer/extension';
import { CppBuildTaskProvider } from '../LanguageServer/cppbuildTaskProvider';
import * as util from '../common';
import * as fs from 'fs';
import * as Telemetry from '../telemetry';
import { buildAndDebugActiveFileStr } from './extension';
import * as logger from '../logger';
import * as nls from 'vscode-nls';

import { IConfiguration, IConfigurationSnippet, DebuggerType, MIConfigurations, WindowsConfigurations, WSLConfigurations, PipeTransportConfigurations } from './configurations';
import { parse } from 'jsonc-parser';
import { PlatformInformation } from '../platform';
import { Environment, ParsedEnvironmentFile } from './ParsedEnvironmentFile';

nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

function isDebugLaunchStr(str: string): boolean {
    return str.startsWith("(gdb) ") || str.startsWith("(lldb) ") || str.startsWith("(Windows) ");
}

/*
 * Retrieves configurations from a provider and displays them in a quickpick menu to be selected.
 * Ensures that the selected configuration's preLaunchTask (if existent) is populated in the user's task.json.
 * Automatically starts debugging for "Build and Debug" configurations.
 */
export class QuickPickConfigurationProvider implements vscode.DebugConfigurationProvider {
    private underlyingProvider: vscode.DebugConfigurationProvider;

    public constructor(provider: CppConfigurationProvider) {
        this.underlyingProvider = provider;
    }

    async provideDebugConfigurations(folder?: vscode.WorkspaceFolder, token?: vscode.CancellationToken): Promise<vscode.DebugConfiguration[]> {
        let configs: vscode.DebugConfiguration[] | null | undefined = this.underlyingProvider.provideDebugConfigurations ? await this.underlyingProvider.provideDebugConfigurations(folder, token) : undefined;
        if (!configs) {
            configs = [];
        }
        const defaultConfig: vscode.DebugConfiguration | undefined = configs.find(config => isDebugLaunchStr(config.name) && config.request === "launch");
        if (!defaultConfig) {
            throw new Error("Default config not found in provideDebugConfigurations()");
        }
        const editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor;
        if (!editor || !util.fileIsCOrCppSource(editor.document.fileName) || configs.length <= 1) {
            return [defaultConfig];
        }
        interface MenuItem extends vscode.QuickPickItem {
            configuration: vscode.DebugConfiguration;
        }

        const items: MenuItem[] = configs.map<MenuItem>(config => {
            let menuItem: MenuItem = {label: config.name, configuration: config};
            // Rename the menu item for the default configuration as its name is non-descriptive.
            if (isDebugLaunchStr(menuItem.label)) {
                menuItem.label = localize("default.configuration.menuitem", "Default Configuration");
            }
            return menuItem;
        });

        const selection: MenuItem | undefined = await vscode.window.showQuickPick(items, {placeHolder: localize("select.configuration", "Select a configuration")});
        if (!selection) {
            throw new Error(); // User canceled it.
        }
        if (selection.label.startsWith("cl.exe")) {
            if (!process.env.DevEnvDir) {
                vscode.window.showErrorMessage(localize("cl.exe.not.available", "{0} build and debug is only usable when VS Code is run from the Developer Command Prompt for VS.", "cl.exe"));
                throw new Error();
            }
        }
        if (selection.label.indexOf(buildAndDebugActiveFileStr()) !== -1 && selection.configuration.preLaunchTask) {
            try {
                await util.ensureBuildTaskExists(selection.configuration.preLaunchTask);
                await vscode.debug.startDebugging(folder, selection.configuration);
                Telemetry.logDebuggerEvent("buildAndDebug", { "success": "true" });
            } catch (e) {
                Telemetry.logDebuggerEvent("buildAndDebug", { "success": "false" });
            }
        }
        return [selection.configuration];
    }

    resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: vscode.CancellationToken): vscode.ProviderResult<vscode.DebugConfiguration> {
        return this.underlyingProvider.resolveDebugConfiguration ? this.underlyingProvider.resolveDebugConfiguration(folder, config, token) : undefined;
    }
}

class CppConfigurationProvider implements vscode.DebugConfigurationProvider {
    private type: DebuggerType;
    private provider: IConfigurationAssetProvider;

    public constructor(provider: IConfigurationAssetProvider, type: DebuggerType) {
        this.provider = provider;
        this.type = type;
    }

    /**
	 * Returns a list of initial debug configurations based on contextual information, e.g. package.json or folder.
	 */
    async provideDebugConfigurations(folder?: vscode.WorkspaceFolder, token?: vscode.CancellationToken): Promise<vscode.DebugConfiguration[]> {
        let buildTasks: vscode.Task[] = await new CppBuildTaskProvider().provideTasks();
        if (buildTasks.length === 0) {
            return Promise.resolve(this.provider.getInitialConfigurations(this.type));
        }
        const defaultConfig: vscode.DebugConfiguration = this.provider.getInitialConfigurations(this.type).find((config: any) =>
            isDebugLaunchStr(config.name) && config.request === "launch");
        console.assert(defaultConfig, "Could not find default debug configuration.");

        const platformInfo: PlatformInformation = await PlatformInformation.GetPlatformInformation();
        const platform: string = platformInfo.platform;

        // Filter out build tasks that don't match the currently selected debug configuration type.
        buildTasks = buildTasks.filter((task: vscode.Task) => {
            if (defaultConfig.name.startsWith("(Windows) ")) {
                if (task.name.startsWith("cl.exe")) {
                    return true;
                }
            } else {
                if (!task.name.startsWith("cl.exe")) {
                    return true;
                }
            }
            return false;
        });

        // Generate new configurations for each build task.
        // Generating a task is async, therefore we must *await* *all* map(task => config) Promises to resolve.
        let configs: vscode.DebugConfiguration[] = await Promise.all(buildTasks.map<Promise<vscode.DebugConfiguration>>(async task => {
            const definition: BuildTaskDefinition = task.definition as BuildTaskDefinition;
            const compilerName: string = path.basename(definition.compilerPath);

            let newConfig: vscode.DebugConfiguration = {...defaultConfig}; // Copy enumerables and properties

            newConfig.name = compilerName + buildAndDebugActiveFileStr();
            newConfig.preLaunchTask = task.name;
            newConfig.externalConsole = false;
            const exeName: string = path.join("${fileDirname}", "${fileBasenameNoExtension}");
            newConfig.program = platform === "win32" ? exeName + ".exe" : exeName;

            return new Promise<vscode.DebugConfiguration>(resolve => {
                if (platform === "darwin") {
                    return resolve(newConfig);
                } else {
                    let debuggerName: string;
                    if (compilerName.startsWith("clang")) {
                        newConfig.MIMode = "lldb";
                        const suffixIndex: number = compilerName.indexOf("-");
                        const suffix: string = suffixIndex === -1 ? "" : compilerName.substr(suffixIndex);
                        debuggerName = "lldb-mi" + suffix;
                    } else if (compilerName === "cl.exe") {
                        newConfig.miDebuggerPath = undefined;
                        newConfig.type = "cppvsdbg";
                        return resolve(newConfig);
                    } else {
                        debuggerName = "gdb";
                    }

                    if (platform === "win32") {
                        debuggerName += ".exe";
                    }

                    const compilerDirname: string = path.dirname(definition.compilerPath);
                    const debuggerPath: string = path.join(compilerDirname, debuggerName);
                    fs.stat(debuggerPath, (err, stats: fs.Stats) => {
                        if (!err && stats && stats.isFile) {
                            newConfig.miDebuggerPath = debuggerPath;
                        } else {
                            // TODO should probably resolve a missing debugger in a more graceful fashion for win32.
                            newConfig.miDebuggerPath = path.join("/usr", "bin", debuggerName);
                        }
                        return resolve(newConfig);
                    });
                }
            });
        }));
        configs.push(defaultConfig);
        return configs;
    }

    /**
	 * Try to add all missing attributes to the debug configuration being launched.
	 */
    resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: vscode.CancellationToken): vscode.ProviderResult<vscode.DebugConfiguration> {
        if (config) {
            if (config.type === 'cppvsdbg') {
                // Fail if cppvsdbg type is running on non-Windows
                if (os.platform() !== 'win32') {
                    logger.getOutputChannelLogger().showWarningMessage(localize("debugger.not.available", "Debugger of type: '{0}' is only available on Windows. Use type: '{1}' on the current OS platform.", "cppvsdbg", "cppdbg"));
                    return undefined;
                }

                // Disable debug heap by default, enable if 'enableDebugHeap' is set.
                if (!config.enableDebugHeap) {
                    const disableDebugHeapEnvSetting: Environment = {"name" : "_NO_DEBUG_HEAP", "value" : "1"};

                    if (config.environment && util.isArray(config.environment)) {
                        config.environment.push(disableDebugHeapEnvSetting);
                    } else {
                        config.environment = [disableDebugHeapEnvSetting];
                    }
                }
            }

            // Add environment variables from .env file
            this.resolveEnvFile(config, folder);

            this.resolveSourceFileMapVariables(config);

            // Modify WSL config for OpenDebugAD7
            if (os.platform() === 'win32' &&
                config.pipeTransport &&
                config.pipeTransport.pipeProgram) {
                let replacedPipeProgram: string | undefined;
                const pipeProgramStr: string = config.pipeTransport.pipeProgram.toLowerCase().trim();

                // OpenDebugAD7 is a 32-bit process. Make sure the WSL pipe transport is using the correct program.
                replacedPipeProgram = debugUtils.ArchitectureReplacer.checkAndReplaceWSLPipeProgram(pipeProgramStr, debugUtils.ArchType.ia32);

                // If pipeProgram does not get replaced and there is a pipeCwd, concatenate with pipeProgramStr and attempt to replace.
                if (!replacedPipeProgram && !path.isAbsolute(pipeProgramStr) && config.pipeTransport.pipeCwd) {
                    const pipeCwdStr: string = config.pipeTransport.pipeCwd.toLowerCase().trim();
                    const newPipeProgramStr: string = path.join(pipeCwdStr, pipeProgramStr);

                    replacedPipeProgram = debugUtils.ArchitectureReplacer.checkAndReplaceWSLPipeProgram(newPipeProgramStr, debugUtils.ArchType.ia32);
                }

                if (replacedPipeProgram) {
                    config.pipeTransport.pipeProgram = replacedPipeProgram;
                }
            }

            const macOSMIMode: string = config.osx?.MIMode ?? config.MIMode;
            const macOSMIDebuggerPath: string = config.osx?.miDebuggerPath ?? config.miDebuggerPath;

            const lldb_mi_10_x_path: string = path.join(util.extensionPath, "debugAdapters", "lldb-mi", "bin", "lldb-mi");

            // Validate LLDB-MI
            if (os.platform() === 'darwin' && // Check for macOS
                fs.existsSync(lldb_mi_10_x_path) && // lldb-mi 10.x exists
                (!macOSMIMode || macOSMIMode === 'lldb') &&
                !macOSMIDebuggerPath // User did not provide custom lldb-mi
            ) {
                const frameworkPath: string | undefined = this.getLLDBFrameworkPath();

                if (!frameworkPath) {
                    const moreInfoButton: string = localize("lldb.framework.install.xcode", "More Info");
                    const LLDBFrameworkMissingMessage: string = localize("lldb.framework.not.found", "Unable to locate 'LLDB.framework' for lldb-mi. Please install XCode or XCode Command Line Tools.");

                    vscode.window.showErrorMessage(LLDBFrameworkMissingMessage, moreInfoButton)
                        .then(value => {
                            if (value === moreInfoButton) {
                                let helpURL: string = "https://aka.ms/vscode-cpptools/LLDBFrameworkNotFound";
                                vscode.env.openExternal(vscode.Uri.parse(helpURL));
                            }
                        });

                    return undefined;
                }
            }
        }
        // if config or type is not specified, return null to trigger VS Code to open a configuration file https://github.com/Microsoft/vscode/issues/54213
        return config && config.type ? config : null;
    }

    private getLLDBFrameworkPath(): string | undefined {
        const LLDBFramework: string = "LLDB.framework";
        // Note: When adding more search paths, make sure the shipped lldb-mi also has it. See Build/lldb-mi.yml and 'install_name_tool' commands.
        let searchPaths: string[] = [
            "/Library/Developer/CommandLineTools/Library/PrivateFrameworks", // XCode CLI
            "/Applications/Xcode.app/Contents/SharedFrameworks" // App Store XCode
        ];

        for (const searchPath of searchPaths) {
            if (fs.existsSync(path.join(searchPath, LLDBFramework))) {
                // Found a framework that 'lldb-mi' can use.
                return searchPath;
            }
        }

        const outputChannel: logger.Logger = logger.getOutputChannelLogger();

        outputChannel.appendLine(localize("lldb.find.failed", "Missing dependency '{0}' for lldb-mi executable.", LLDBFramework));
        outputChannel.appendLine(localize("lldb.search.paths", "Searched in:"));
        searchPaths.forEach(searchPath => {
            outputChannel.appendLine(`\t${searchPath}`);
        });
        const xcodeCLIInstallCmd: string = "xcode-select --install";
        outputChannel.appendLine(localize("lldb.install.help", "To resolve this issue, either install XCode through the Apple App Store or install the XCode Command Line Tools by running '{0}' in a Terminal window.", xcodeCLIInstallCmd));
        logger.showOutputChannel();

        return undefined;
    }

    private resolveEnvFile(config: vscode.DebugConfiguration, folder?: vscode.WorkspaceFolder): void {
        if (config.envFile) {
            // replace ${env:???} variables
            let envFilePath: string = util.resolveVariables(config.envFile, undefined);

            try {
                if (folder && folder.uri && folder.uri.fsPath) {
                    // Try to replace ${workspaceFolder} or ${workspaceRoot}
                    envFilePath = envFilePath.replace(/(\${workspaceFolder}|\${workspaceRoot})/g, folder.uri.fsPath);
                }

                const parsedFile: ParsedEnvironmentFile = ParsedEnvironmentFile.CreateFromFile(envFilePath, config["environment"]);

                // show error message if single lines cannot get parsed
                if (parsedFile.Warning) {
                    CppConfigurationProvider.showFileWarningAsync(parsedFile.Warning, config.envFile);
                }

                config.environment = parsedFile.Env;

                delete config.envFile;
            } catch (e) {
                throw new Error(localize("envfale.failed", "Failed to use {0}. Reason: {1}", "envFile", e.message));
            }
        }
    }

    private resolveSourceFileMapVariables(config: vscode.DebugConfiguration): void {
        let messages: string[] = [];
        if (config.sourceFileMap) {
            for (const sourceFileMapSource of Object.keys(config.sourceFileMap)) {
                let message: string = "";
                const sourceFileMapTarget: string = config.sourceFileMap[sourceFileMapSource];

                // TODO: pass config.environment as 'additionalEnvironment' to resolveVariables when it is { key: value } instead of { "key": key, "value": value }
                const newSourceFileMapSource: string = util.resolveVariables(sourceFileMapSource, undefined);
                const newSourceFileMapTarget: string = util.resolveVariables(sourceFileMapTarget, undefined);

                let source: string = sourceFileMapSource;
                let target: string = sourceFileMapTarget;

                if (sourceFileMapSource !== newSourceFileMapSource) {
                    message = "\t" + localize("replacing.sourcepath", "Replacing {0} '{1}' with '{2}'.", "sourcePath", sourceFileMapSource, newSourceFileMapSource);
                    delete config.sourceFileMap[sourceFileMapSource];
                    source = newSourceFileMapSource;
                }

                if (sourceFileMapTarget !== newSourceFileMapTarget) {
                    // Add a space if source was changed, else just tab the target message.
                    message +=  (message ? ' ' : '\t');
                    message += localize("replacing.targetpath", "Replacing {0} '{1}' with '{2}'.", "targetPath", sourceFileMapTarget, newSourceFileMapTarget);
                    target = newSourceFileMapTarget;
                }

                if (message) {
                    config.sourceFileMap[source] = target;
                    messages.push(message);
                }
            }

            if (messages.length > 0) {
                logger.getOutputChannel().appendLine(localize("resolving.variables.in.sourcefilemap", "Resolving variables in {0}...", "sourceFileMap"));
                messages.forEach((message) => {
                    logger.getOutputChannel().appendLine(message);
                });
                logger.showOutputChannel();
            }
        }
    }

    private static async showFileWarningAsync(message: string, fileName: string): Promise<void> {
        const openItem: vscode.MessageItem = { title: localize("open.envfile", "Open {0}", "envFile") };
        let result: vscode.MessageItem | undefined = await vscode.window.showWarningMessage(message, openItem);
        if (result && result.title === openItem.title) {
            let doc: vscode.TextDocument = await vscode.workspace.openTextDocument(fileName);
            if (doc) {
                vscode.window.showTextDocument(doc);
            }
        }
    }
}

export class CppVsDbgConfigurationProvider extends CppConfigurationProvider {
    public constructor(provider: IConfigurationAssetProvider) {
        super(provider, DebuggerType.cppvsdbg);
    }
}

export class CppDbgConfigurationProvider extends CppConfigurationProvider {
    public constructor(provider: IConfigurationAssetProvider) {
        super(provider, DebuggerType.cppdbg);
    }
}

export interface IConfigurationAssetProvider {
    getInitialConfigurations(debuggerType: DebuggerType): any;
    getConfigurationSnippets(): vscode.CompletionItem[];
}

export class ConfigurationAssetProviderFactory {
    public static getConfigurationProvider(): IConfigurationAssetProvider {
        switch (os.platform()) {
            case 'win32':
                return new WindowsConfigurationProvider();
            case 'darwin':
                return new OSXConfigurationProvider();
            case 'linux':
                return new LinuxConfigurationProvider();
            default:
                throw new Error(localize("unexpected.os", "Unexpected OS type"));
        }
    }
}

abstract class DefaultConfigurationProvider implements IConfigurationAssetProvider {
    configurations: IConfiguration[] = [];

    public getInitialConfigurations(debuggerType: DebuggerType): any {
        let configurationSnippet: IConfigurationSnippet[] = [];

        // Only launch configurations are initial configurations
        this.configurations.forEach(configuration => {
            configurationSnippet.push(configuration.GetLaunchConfiguration());
        });

        let initialConfigurations: any = configurationSnippet.filter(snippet => snippet.debuggerType === debuggerType && snippet.isInitialConfiguration)
            .map(snippet => JSON.parse(snippet.bodyText));

        // If configurations is empty, then it will only have an empty configurations array in launch.json. Users can still add snippets.
        return initialConfigurations;
    }

    public getConfigurationSnippets(): vscode.CompletionItem[] {
        let completionItems: vscode.CompletionItem[] = [];

        this.configurations.forEach(configuration => {
            completionItems.push(convertConfigurationSnippetToCompetionItem(configuration.GetLaunchConfiguration()));
            completionItems.push(convertConfigurationSnippetToCompetionItem(configuration.GetAttachConfiguration()));
        });

        return completionItems;
    }
}

class WindowsConfigurationProvider extends DefaultConfigurationProvider {
    private executable: string = "a.exe";
    private pipeProgram: string = "<" + localize("path.to.pipe.program", "full path to pipe program such as {0}", "plink.exe").replace(/\"/g, "\\\"") + ">";
    private MIMode: string = 'gdb';
    private setupCommandsBlock: string = `"setupCommands": [
    {
        "description": "${localize("enable.pretty.printing", "Enable pretty-printing for {0}", "gdb").replace(/\"/g, "\\\"")}",
        "text": "-enable-pretty-printing",
        "ignoreFailures": true
    }
]`;

    constructor() {
        super();
        this.configurations = [
            new MIConfigurations(this.MIMode, this.executable, this.pipeProgram, this.setupCommandsBlock),
            new PipeTransportConfigurations(this.MIMode, this.executable, this.pipeProgram, this.setupCommandsBlock),
            new WindowsConfigurations(this.MIMode, this.executable, this.pipeProgram, this.setupCommandsBlock),
            new WSLConfigurations(this.MIMode, this.executable, this.pipeProgram, this.setupCommandsBlock)
        ];
    }
}

class OSXConfigurationProvider extends DefaultConfigurationProvider {
    private MIMode: string = 'lldb';
    private executable: string = "a.out";
    private pipeProgram: string = "/usr/bin/ssh";

    constructor() {
        super();
        this.configurations = [
            new MIConfigurations(this.MIMode, this.executable, this.pipeProgram)
        ];
    }
}

class LinuxConfigurationProvider extends DefaultConfigurationProvider {
    private MIMode: string = 'gdb';
    private setupCommandsBlock: string = `"setupCommands": [
    {
        "description": "${localize("enable.pretty.printing", "Enable pretty-printing for {0}", "gdb").replace(/\"/g, "\\\"")}",
        "text": "-enable-pretty-printing",
        "ignoreFailures": true
    }
]`;
    private executable: string = "a.out";
    private pipeProgram: string = "/usr/bin/ssh";

    constructor() {
        super();
        this.configurations = [
            new MIConfigurations(this.MIMode, this.executable, this.pipeProgram, this.setupCommandsBlock),
            new PipeTransportConfigurations(this.MIMode, this.executable, this.pipeProgram, this.setupCommandsBlock)
        ];
    }
}

function convertConfigurationSnippetToCompetionItem(snippet: IConfigurationSnippet): vscode.CompletionItem {
    let item: vscode.CompletionItem = new vscode.CompletionItem(snippet.label, vscode.CompletionItemKind.Snippet);

    item.insertText = snippet.bodyText;

    return item;
}

export class ConfigurationSnippetProvider implements vscode.CompletionItemProvider {
    private provider: IConfigurationAssetProvider;
    private snippets: vscode.CompletionItem[];

    constructor(provider: IConfigurationAssetProvider) {
        this.provider = provider;
        this.snippets = this.provider.getConfigurationSnippets();
    }
    public resolveCompletionItem(item: vscode.CompletionItem, token: vscode.CancellationToken): Thenable<vscode.CompletionItem> {
        return Promise.resolve(item);
    }

    // This function will only provide completion items via the Add Configuration Button
    // There are two cases where the configuration array has nothing or has some items.
    // 1. If it has nothing, insert a snippet the user selected.
    // 2. If there are items, the Add Configuration button will append it to the start of the configuration array. This function inserts a comma at the end of the snippet.
    public provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): Thenable<vscode.CompletionList> {
        let items: vscode.CompletionItem[] = this.snippets;

        const launch: any = parse(document.getText());
        // Check to see if the array is empty, so any additional inserted snippets will need commas.
        if (launch.configurations.length !== 0) {
            items = [];

            // Make a copy of each snippet since we are adding a comma to the end of the insertText.
            this.snippets.forEach((item) => items.push({...item}));

            items.map((item) => {
                item.insertText = item.insertText + ','; // Add comma
            });
        }

        return Promise.resolve(new vscode.CompletionList(items, true));
    }
}
