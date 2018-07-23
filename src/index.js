// @flow

import 'core-js/fn/object/entries';

import yamljs from 'yamljs';
import parser from 'yargs-parser';
import deepmerge from 'deepmerge';

import { maybeGetComposeEntry, getComposeJson } from './logic';

export type RawValue = string | number | boolean | [string | number | boolean];

const getServiceName = (image: string): string => {
    let name = image.includes('/') ? image.split('/')[1] : image;
    name = name.includes(':') ? name.split(':')[0] : name;

    return name;
};

const getService = (input: string): any => {
    const formattedInput = input.replace(/(\s)+/g, ' ').trim();
    const parsedInput: {
        +_: Array<string>,
        +[flag: string]: RawValue,
    } = parser(formattedInput);
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
    return {serviceName:serviceName,service:service};
};

export default (input: string): ?string => {
    const containers = input.split('+');
    const services = {};
    for (let i = 0; i < containers.length; i= i + 1) {
        const service = getService(containers[i]);
        services[service.serviceName] = service.service;
    }
    // Outer template
    const result = {
        version: '3.3',
        services,
    };

    return yamljs.stringify(result, 9, 4).trim();
};
