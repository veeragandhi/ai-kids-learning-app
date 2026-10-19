import PDFParser from "pdf2json";

// Minimal shapes for the pdf2json events we consume (pdf2json ships no
// bundled types). `T` holds URI-encoded text for one run on the page.
interface PdfTextRun {
  T: string;
}

interface PdfTextItem {
  R: PdfTextRun[];
}

interface PdfPage {
  Texts: PdfTextItem[];
}

interface PdfParserData {
  Pages: PdfPage[];
}

interface PdfParserError {
  parserError: Error;
}

export async function extractPdfText(
  buffer: Buffer
): Promise<string> {

  const pdfParser = new PDFParser();

  return new Promise<string>((resolve, reject) => {

    pdfParser.on(
      "pdfParser_dataError",
      (errData: Error | PdfParserError) => {
        reject(errData instanceof Error ? errData : errData.parserError);
      }
    );

    pdfParser.on(
      "pdfParser_dataReady",
      (pdfData: PdfParserData) => {

        try {

          let text = "";

          pdfData.Pages.forEach((page: PdfPage) => {

            page.Texts.forEach((textItem: PdfTextItem) => {

              textItem.R.forEach((run: PdfTextRun) => {

                text +=
                  decodeURIComponent(run.T) + " ";
              });
            });

            text += "\n";
          });

          resolve(text);

        } catch (err) {

          reject(err);
        }
      }
    );

    pdfParser.parseBuffer(buffer);
  });
}