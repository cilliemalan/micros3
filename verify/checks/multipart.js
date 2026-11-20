import { verifyCreateMultipartUpload } from './create-multipart-upload.js';
import { verifyAbortMultipartUpload } from './abort-multipart-upload.js';
import { verifyUploadPart } from './upload-part.js';
import { verifyCompleteMultipartUpload } from './complete-multipart-upload.js';
import { verifyListParts } from './list-parts.js';
import { verifyListMultipartUploads } from './list-multipart-uploads.js';

export default [
  { name: 'CreateMultipartUpload', run: ({ client }) => verifyCreateMultipartUpload(client) },
  { name: 'UploadPart', run: ({ client }) => verifyUploadPart(client) },
  { name: 'ListParts', run: ({ client }) => verifyListParts(client) },
  { name: 'ListMultipartUploads', run: ({ client }) => verifyListMultipartUploads(client) },
  { name: 'CompleteMultipartUpload', run: ({ client }) => verifyCompleteMultipartUpload(client) },
  { name: 'AbortMultipartUpload', run: ({ client }) => verifyAbortMultipartUpload(client) },
];
