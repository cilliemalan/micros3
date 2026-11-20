import { verifyCreateMultipartUpload } from './create-multipart-upload.js';

export default [
  { name: 'CreateMultipartUpload', run: ({ client }) => verifyCreateMultipartUpload(client) },
  { name: 'UploadPart', run() { throw new Error('Not implemented'); } },
  { name: 'ListMultipartUploads', run() { throw new Error('Not implemented'); } },
  { name: 'CompleteMultipartUpload', run() { throw new Error('Not implemented'); } },
  { name: 'AbortMultipartUpload', run() { throw new Error('Not implemented'); } },
];
