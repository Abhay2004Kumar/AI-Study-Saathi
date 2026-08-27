const { PDFLoader } = require('@langchain/community/document_loaders/fs/pdf');
const fs = require('fs');

/**
 * Loads a file into LangChain Document objects based on its type.
 * Shared by document ingestion (Phase 2/3) and syllabus text extraction
 * (Phase 1), which both need raw text out of an uploaded PDF/TXT/MD file.
 *
 * @param {string} filePath
 * @param {string} fileType - MIME type, e.g. 'application/pdf'
 * @param {string} [fileName] - used as a fallback when the MIME type is generic
 * @returns {Promise<Array<{pageContent: string, metadata: object}>>}
 */
async function loadDocumentAsLangchainDocs(filePath, fileType, fileName = '') {
  if (fileType === 'application/pdf') {
    const loader = new PDFLoader(filePath);
    return loader.load();
  }

  if (
    fileType === 'text/plain' ||
    fileType === 'text/markdown' ||
    fileName.endsWith('.md') ||
    fileName.endsWith('.txt')
  ) {
    const text = fs.readFileSync(filePath, 'utf-8');
    return [{ pageContent: text, metadata: { source: filePath } }];
  }

  throw new Error(`Unsupported file type for processing: ${fileType}`);
}

module.exports = { loadDocumentAsLangchainDocs };
