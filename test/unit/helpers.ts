import type { Collection, Folder, RequestItem } from '../../src/core/model/types';
import { defaultSettings } from '../../src/core/model/types';

export function sampleRequest(overrides: Partial<RequestItem> = {}): RequestItem {
  return {
    kind: 'request',
    id: 'req_00000000000000000000000000000001',
    name: 'List users',
    sortKey: 0,
    method: 'GET',
    url: '{{ _.base_url }}/users',
    parameters: [{ name: 'page', value: '1', disabled: false }],
    pathParameters: [],
    headers: [{ name: 'Accept', value: 'application/json' }],
    body: {},
    authentication: { type: 'bearer', token: '{{ _.token }}', prefix: 'Bearer', disabled: false },
    settings: defaultSettings(),
    ...overrides,
  };
}

export function sampleFolder(overrides: Partial<Folder> = {}): Folder {
  return {
    kind: 'folder',
    id: 'fld_00000000000000000000000000000001',
    name: 'Users',
    sortKey: 0,
    environment: { region: 'tw' },
    children: [],
    ...overrides,
  };
}

export function sampleCollection(overrides: Partial<Collection> = {}): Collection {
  const folder = sampleFolder({
    children: [
      sampleRequest(),
      sampleRequest({
        id: 'req_00000000000000000000000000000002',
        name: 'Create user',
        sortKey: 1,
        method: 'POST',
        url: '{{ _.base_url }}/users',
        parameters: [],
        headers: [],
        body: { mimeType: 'application/json', text: '{"name":"n"}' },
        authentication: {},
      }),
    ],
  });
  return {
    id: 'wrk_00000000000000000000000000000001',
    name: 'My API',
    created: 1700000000000,
    modified: 1700000000000,
    servers: ['https://api.example.com'],
    children: [
      folder,
      sampleRequest({
        id: 'req_00000000000000000000000000000003',
        name: 'Health',
        sortKey: 1,
        url: 'https://api.example.com/health',
        parameters: [],
        headers: [],
        authentication: {},
      }),
    ],
    environments: {
      base: {
        id: 'env_00000000000000000000000000000001',
        name: 'Base Environment',
        color: null,
        data: { base_url: 'https://api.example.com', token: '' },
      },
      subEnvironments: [
        {
          id: 'env_00000000000000000000000000000002',
          name: 'Production',
          color: '#8abc39',
          isPrivate: false,
          data: { token: 'prod-token' },
        },
      ],
    },
    cookieJar: { id: 'jar_00000000000000000000000000000001', name: 'Default Jar', cookies: [] },
    ...overrides,
  };
}
