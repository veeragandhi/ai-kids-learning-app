import PDFParser from "pdf2json";

export async function extractPdfText(
  buffer: Buffer
): Promise<string> {

  const pdfParser = new PDFParser();

  return new Promise<string>((resolve, reject) => {

    pdfParser.on(
      "pdfParser_dataError",
      (errData: any) => {
        reject(errData.parserError);
      }
    );

    pdfParser.on(
      "pdfParser_dataReady",
      (pdfData: any) => {

        try {

          let text = "";

          pdfData.Pages.forEach((page: any) => {

            page.Texts.forEach((textItem: any) => {

              textItem.R.forEach((run: any) => {

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