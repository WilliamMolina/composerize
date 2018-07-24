// @flow

import 'core-js/fn/object/entries';

import yamljs from 'yamljs';
import parser from 'yargs-parser';
import deepmerge from 'deepmerge';
import { maybeGetComposeEntry, getComposeJson } from './logic';
export type RawValue = string | number | boolean | [string | number | boolean];
const childp = require('child-process-promise').spawn;
const getServiceName = (image: string): string => {
    let name = image.includes('/') ? image.split('/')[1] : image;
    name = name.includes(':') ? name.split(':')[0] : name;

    return name;
};

const getService = (input: string): any => {
    const formattedInput = input.replace(/(\s)+/g, ' ').trim();
    const parsedInput: {
        +_: Array < string >,
        +[flag: string]: RawValue,
    } = parser(formattedInput, { boolean: ['i', 't', 'd'] });
const { _: command, ...params } = parsedInput;

if (command[0] !== 'docker' || command[1] !== 'run') {
    throw new SyntaxError('must be a valid docker run command');
}

// The service object that we'll update
let service = {};

// Loop through the tokens and append to the service object
Object.entries(params).forEach(
    // https://github.com/facebook/flow/issues/2174
    // $FlowFixMe: Object.entries wipes out types ATOW
    ([key, value]: [string, RawValue]) => {
        const composeEntry = maybeGetComposeEntry(key, value);
        if (composeEntry) {
            // Store whatever the next entry will be
            const json = getComposeJson(composeEntry);
            service = deepmerge(service, json);
        }
    },
);

const image = command.slice(-1)[0];
service.image = image;

const serviceName = getServiceName(image);
return { serviceName, service };
};

export default (input: string): ?string => {
    let containers = input.split('+');
    const names = containers.filter(value => { return value.trim().split(' ').length === 1 }).map(value => { return value.trim() });
    containers = containers.filter(value => { return value.trim().split(' ').length !== 1 });
    const services = {};
    let promises = [];
    let info = [];
    if (names.length > 0) {
        var promise = childp('docker', ['inspect'].concat(names));
        promises.push(promise);
        var childProcess = promise.childProcess;
        childProcess.stdout.on('data', function (data) {
            info.push(data);
        });
    }
    for (let i = 0; i < containers.length; i += 1) {
        const service = getService(containers[i]);
        services[service.serviceName] = service.service;
    }
    Promise.all(promises).then(values => {
        if (names.length > 0) {
            const commands = parse(info.join(''));
            for (let i = 0; i < commands.length; i += 1) {
                const service = getService(commands[i].command);
                services[service.serviceName] = service.service;
            }
        }
        // Outer template  
        const result = {
            version: '3.3',
            services,
        };
        console.log(yamljs.stringify(result, 9, 4).trim());
    });
};

// json string could be an array from `docker inspect` or
// a single inspected object; always returns an array
const parse = function parse(jsonString) {
    return [].concat(translate(JSON.parse(jsonString)))
}

// translate a parsed array or object into "docker run objects"
// returns an array if given an array, otherwise returns an object
const translate = function translate(parsed) {
    return Array.isArray(parsed) ? parsed.map((o) => toRunObject(o)) : toRunObject(parsed)
}

function toRunObject(inspectObj) {
    let run = {}

    run.image = shortHash(inspectObj.Image)
    run.id = shortHash(inspectObj.Id)

    run.name = inspectObj.Name
    if (run.name && run.name.indexOf('/') === 0) run.name = run.name.substring(1)

    run.command = toRunCommand(inspectObj, run.name)

    return run
}

function shortHash(hash) {
    if (hash && hash.length && hash.length > 12) return hash.substring(0, 12)
    return hash
}

function toRunCommand(inspectObj, name) {
    let rc = append('docker run', '--name', name)

    let hostcfg = inspectObj.HostConfig || {}
    rc = appendArray(rc, '-v', hostcfg.Binds)
    rc = appendArray(rc, '--volumes-from', hostcfg.VolumesFrom)
    if (hostcfg.PortBindings) {
        rc = appendObjectKeys(rc, '-p', hostcfg.PortBindings, (ipPort) => {
            return ipPort.HostIp ? ipPort.HostIp + ':' + ipPort.HostPort : ipPort.HostPort
        })
    }
    rc = appendArray(rc, '--link', hostcfg.Links, (link) => {
        link = link.split(':')
        if (link[0] && ~link[0].lastIndexOf('/')) link[0] = link[0].substring(link[0].lastIndexOf('/') + 1)
        if (link[1] && ~link[1].lastIndexOf('/')) link[1] = link[1].substring(link[1].lastIndexOf('/') + 1)
        return link[0] + ':' + link[1]
    })
    if (hostcfg.PublishAllPorts) rc = rc + ' -P'
    if (hostcfg.NetworkMode && hostcfg.NetworkMode !== 'default') {
        rc = append(rc, '--net', hostcfg.NetworkMode)
    }
    if (hostcfg.RestartPolicy && hostcfg.RestartPolicy.Name) {
        rc = append(rc, '--restart', hostcfg.RestartPolicy, (policy) => {
            return policy.Name === 'on-failure' ? policy.Name + ':' + policy.MaximumRetryCount : policy.Name
        })
    }
    rc = appendArray(rc, '--add-host', hostcfg.ExtraHosts)

    let cfg = inspectObj.Config || {}
    if (cfg.Hostname) rc = append(rc, '-h', cfg.Hostname)
    if (cfg.ExposedPorts) {
        rc = appendObjectKeys(rc, '--expose', cfg.ExposedPorts)
    }
    rc = appendArray(rc, '-e', cfg.Env, (env) => '\'' + env.replace(/'/g, '\'\\\'\'') + '\'')
    rc = appendConfigBooleans(rc, cfg)
    if (cfg.Entrypoint) rc = appendJoinedArray(rc, '--entrypoint', cfg.Entrypoint, ' ')

    rc = rc + ' ' + (cfg.Image || inspectObj.Image)

    if (cfg.Cmd) rc = appendJoinedArray(rc, null, cfg.Cmd, ' ')

    return rc
}

function appendConfigBooleans(str, cfg) {
    let stdin = cfg.AttachStdin === true
    let stdout = cfg.AttachStdout === true
    let stderr = cfg.AttachStderr === true
    str = appendBoolean(str, !stdin && !stdout && !stderr, '-d')
    str = appendBoolean(str, stdin, '-a', 'stdin')
    str = appendBoolean(str, stdout, '-a', 'stdout')
    str = appendBoolean(str, stderr, '-a', 'stderr')
    str = appendBoolean(str, cfg.Tty === true, '-t')
    str = appendBoolean(str, cfg.OpenStdin === true, '-i')
    return str
}

function appendBoolean(str, bool, key, val) {
    return bool ? (val ? append(str, key, val) : str + ' ' + key) : str
}

function appendJoinedArray(str, key, array, join) {
    if (!Array.isArray(array)) return str
    return append(str, key, array.join(join), (joined) => {
        return key ? '"' + joined + '"' : joined
    })
}

function appendObjectKeys(str, key, obj, transformer) {
    let newStr = str
    Object.keys(obj).forEach((k) => {
        newStr = append(newStr, key, { 'key': k, val: obj[k] }, (agg) => {
            if (!agg.val) return agg.key
            let v = ''
            if (Array.isArray(agg.val)) {
                agg.val.forEach((valObj) => {
                    v = (typeof transformer === 'function' ? transformer(valObj) : valObj)
                })
            }
            return (v ? v + ':' : '') + agg.key
        })
    })
    return newStr
}

function appendArray(str, key, array, transformer) {
    if (!Array.isArray(array)) return str
    let newStr = str
    array.forEach((v) => {
        newStr = append(newStr, key, v, transformer)
    })
    return newStr
}

function append(str, key, val, transformer) {
    if (!val) return str
    return str + ' ' + (key ? key + ' ' : '') + (typeof transformer === 'function' ? transformer(val) : val)
}