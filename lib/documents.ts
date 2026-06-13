import fs from "fs";
import path from "path";

export type DocumentItem = {
  name: string;
  approved: boolean;
};

const uploadDir = path.join(
  process.cwd(),
  "uploads"
);

const metadataPath = path.join(
  uploadDir,
  "documents.json"
);

export function getApprovedDocumentText() {

  const uploadDir = path.join(
    process.cwd(),
    "uploads"
  );

  const metadataPath = path.join(
    uploadDir,
    "documents.json"
  );

  let documentText = "";

  if (
    fs.existsSync(uploadDir) &&
    fs.existsSync(metadataPath)
  ) {

    const documents = JSON.parse(
      fs.readFileSync(metadataPath, "utf-8")
    );

    const approvedDocs = documents.filter(
      (doc: any) => doc.approved
    );

    approvedDocs.forEach((doc: any) => {

      const content = fs.readFileSync(
        path.join(uploadDir, doc.name),
        "utf-8"
      );

      documentText += content + "\n";
    });
  }

  return documentText;
}

export function saveTextDocument(
  fileName: string,
  text: string
) {

  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
  }

  const textPath = path.join(
    uploadDir,
    fileName
  );

  fs.writeFileSync(textPath, text);
}

export function getDocuments(): DocumentItem[] {

  if (!fs.existsSync(metadataPath)) {
    return [];
  }

  return JSON.parse(
    fs.readFileSync(metadataPath, "utf-8")
  );
}

export function saveDocuments(
  documents: DocumentItem[]
) {

  fs.writeFileSync(
    metadataPath,
    JSON.stringify(documents, null, 2)
  );
}

export function addDocument(
  fileName: string
) {

  const documents = getDocuments();

  const exists = documents.find(
    (d) => d.name === fileName
  );

  if (!exists) {

    documents.push({
      name: fileName,
      approved: true
    });

    saveDocuments(documents);
  }
}