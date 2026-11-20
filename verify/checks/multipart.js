import { verifyCreateMultipartUpload } from './create-multipart-upload.js';
import { verifyAbortMultipartUpload } from './abort-multipart-upload.js';
import { verifyUploadPart } from './upload-part.js';

export default [
  { name: 'CreateMultipartUpload', run: ({ client }) => verifyCreateMultipartUpload(client) },
  { name: 'UploadPart', run: ({ client }) => verifyUploadPart(client) },
  { name: 'ListMultipartUploads', run() { throw new Error('Not implemented'); } },
  { name: 'CompleteMultipartUpload', run() { throw new Error('Not implemented'); } },
  { name: 'AbortMultipartUpload', run: ({ client }) => verifyAbortMultipartUpload(client) },
];
