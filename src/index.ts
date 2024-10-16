import { ArgumentParser } from 'argparse';
import fs from 'fs';
import { exec } from 'child_process';
import { version } from '../package.json';

const regex = /^.*\s(?<process>[a-zA-Z0-9:[\]\-_()]+)\((?<pid>[0-9]+)\):\s+(?<operation>[A-Z+<>]+)\s+(?<path>.*)$/gm;

enum Operation {
    OPEN = 'O',
    CLOSE = 'C',
    READ = 'R',
    WRITE = 'W',
    DELETE = 'D',
}

export interface Args {
    file: string;
    open: boolean;
}

export interface Line {
    pid: string;
    operation: string;
    path: string;
    process: string;
}

export interface ParsedLine extends Line {
    operations: Operation[];
    rawOperations: string[];
}

export interface Statistics {
    pathsCount: number;
    countPerPath: {
        [key: string]: number;
    }
    pidCount: number;
    countPerPid: {
        [key: string]: number;
    }
    writePathsCount: number;
    countPerWritePath: {
        [key: string]: number;
    }
    pidToProcessMap: {
        [key: string]: string;
    }
}

const renderStatisticsToHtml = (statistics: Statistics): string => {
    const {
        pathsCount, countPerPath, pidCount, countPerPid, countPerWritePath, writePathsCount,
        pidToProcessMap,
    } = statistics;

    const sortedPathsByCount = Object.keys(countPerPath).sort((a, b) => countPerPath[b] - countPerPath[a]);
    const pathsList = sortedPathsByCount.map((path) => `<li>${path}: ${countPerPath[path]}</li>`).join('');

    const sortedWritePathsByCount = Object.keys(countPerWritePath).sort((a, b) => countPerWritePath[b] - countPerWritePath[a]);
    const writePathsList = sortedWritePathsByCount.map((path) => `<li>${path}: ${countPerWritePath[path]}</li>`).join('');

    const sortedPidsByCount = Object.keys(countPerPid).sort((a, b) => countPerPid[b] - countPerPid[a]);
    const pidsList = sortedPidsByCount.map((pid) => `<li data-pid="${pid}">${pid} (${pidToProcessMap[pid]}): ${countPerPid[pid]}</li>`).join('');

    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>fatrace-parser</title>
            <!-- bootstrap -->
            <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.0.0-alpha1/dist/css/bootstrap.min.css" rel="stylesheet">
            <style>
                .problem {
                    margin-top: 20px;
                    padding: 16px;
                    border-radius: 32px;
                }
                
                .problem:nth-child(odd) {
                    background-color: #f8d7da;
                }
                
                .problem:nth-child(even) {
                    background-color: #f8f1f1;
                }
            </style>
        </head>
        <body>
            <div class="container-fluid mt-3">
                <h1>Statistics</h1>
                <p>Number of unique paths: ${pathsCount} <a href="#problems-by-path">Goto</a></p>
                <p>Number of unique write paths: ${writePathsCount} <a href="#write-problems-by-path">Goto</a></p>
                <p>Number of unique PIDs: ${pidCount} <a href="#problems-by-pid">Goto</a></p>
                <div class="problem">
                    <h2 id="problems-by-path">Problems by path</h2>
                    <ul>
                        ${pathsList}
                    </ul>
                </div>
                <div class="problem">
                    <h2 id="write-problems-by-path">Write problems by path</h2>
                    <ul>
                        ${writePathsList}
                    </ul>
                </div>
                <div class="problem">
                    <h2 id="problems-by-pid">Problems by PID</h2>
                    <ul>
                        ${pidsList}
                    </ul>
                </div>
            </div>
        </body>
        </html>
    `;
};

const createTmpHtmlFile = (content: string, open?: boolean): void => {
    const tmpHtmlPath = '/tmp/fatrace-parser.html';
    fs.writeFileSync(tmpHtmlPath, content);

    if (open) {
        switch (process.platform) {
            case 'darwin':
                exec(`open ${tmpHtmlPath}`);
                break;
            case 'win32':
                exec(`start ${tmpHtmlPath}`);
                break;
            default:
                exec(`xdg-open ${tmpHtmlPath}`);
                break;
        }
    }
};

const operationValueToKey = (value: string): string => Object.keys(Operation).find((key) => Operation[key as keyof typeof Operation] === value) ?? '';

const main = async (): Promise<void> => {
    const parser = new ArgumentParser({
        description: 'A tool to parse output of fatrace command',
    });

    parser.add_argument('-v', '--version', { action: 'version', version });
    parser.add_argument('file', { help: 'Path to the file with fatrace output' });
    parser.add_argument('--open', { action: 'store_true', help: 'Open generated HTML in the browser' });

    const args = parser.parse_args() as Args;

    if (!args.file) {
        parser.print_help();
        return;
    }

    if (!fs.existsSync(args.file)) {
        console.error(`File ${args.file} does not exist`);
        process.exit(1);
    }

    const rawData = fs.readFileSync(args.file, 'utf8').split('\n').filter((line) => line !== '');

    let parseErrors = 0;

    const parsed = rawData.map((line) => {
        const regexCopy = new RegExp(regex);

        if (!line) {
            return null;
        }

        const match = regexCopy.exec(line);
        if (match?.groups) {
            if (!match.groups.pid || !match.groups.operation || !match.groups.path || !match.groups.process) {
                console.log('Missing properties', match.groups, line);
                parseErrors += 1;

                return null;
            }

            return {
                pid: match.groups.pid,
                operation: match.groups.operation,
                path: match.groups.path,
                process: match.groups.process,
            };
        }

        parseErrors += 1;

        return null;
    }).filter((line) => line !== null) as Line[];

    console.log(`Parsed ${parsed.length} lines with ${parseErrors} errors (input lines: ${rawData.length})`);

    console.log('Creating statistics...');

    const parsedWithOperation = parsed.map((line) => {
        // operation is for example CO, we need to map it to [Operation.CLOSE, Operation.OPEN]
        const rawOperations = line.operation.split('');
        const operations = rawOperations.map(operationValueToKey).filter((operation) => operation !== '');

        return {
            ...line,
            rawOperations,
            operations,
        };
    }) as ParsedLine[];

    const groupedByPath = parsedWithOperation.reduce((acc, line) => {
        if (!acc[line.path]) {
            acc[line.path] = [];
        }

        acc[line.path].push(line);

        return acc;
    }, {} as Record<string, ParsedLine[]>);

    const groupedByPid = parsedWithOperation.reduce((acc, line) => {
        if (!acc[line.pid]) {
            acc[line.pid] = 0;
        }

        acc[line.pid] += 1;

        return acc;
    }, {} as Record<string, number>);

    const writePaths = parsedWithOperation.filter((line) => line.rawOperations.includes(Operation.WRITE));
    const groupedByWritePath = writePaths.reduce((acc, line) => {
        if (!acc[line.path]) {
            acc[line.path] = 0;
        }

        acc[line.path] += 1;

        return acc;
    }, {} as Record<string, number>);

    const statistics: Statistics = {
        pathsCount: Object.keys(groupedByPath).length,
        pidCount: Object.keys(groupedByPid).length,
        writePathsCount: Object.keys(groupedByWritePath).length,
        countPerPath: {},
        countPerPid: {},
        countPerWritePath: {},
        pidToProcessMap: {},
    };

    Object.keys(groupedByPath).forEach((path) => {
        statistics.countPerPath[path] = groupedByPath[path].length;
    });

    Object.keys(groupedByPid).forEach((pid) => {
        statistics.countPerPid[pid] = groupedByPid[pid];
    });

    Object.keys(groupedByWritePath).forEach((path) => {
        statistics.countPerWritePath[path] = groupedByWritePath[path];
    });

    const pids = Object.keys(groupedByPid);
    for (const pid of pids) {
        const process = parsedWithOperation.find((line) => line.pid === pid)?.process;
        if (process) {
            statistics.pidToProcessMap[pid] = process;
        }
    }

    console.log('Processing done, generating HTML...');

    const html = renderStatisticsToHtml(statistics);

    createTmpHtmlFile(html, args.open);

    console.log('HTML file generated');
};

main().catch(console.error);
