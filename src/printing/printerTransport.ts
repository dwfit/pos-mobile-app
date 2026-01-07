// src/printing/printerTransport.ts

// If you use react-native-tcp-socket:
// import TcpSocket from "react-native-tcp-socket";

export type PrinterTarget = {
    ip: string;
    port?: number; // most printers = 9100
  };
  
  export class PrinterError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "PrinterError";
    }
  }
  
  /**
   * Fake implementation – for now just log.
   * Replace with real TCP code when you add the library.
   */
  export async function sendToPrinter(
    target: PrinterTarget,
    data: Uint8Array
  ): Promise<void> {
    const port = target.port ?? 9100;
  
    console.log(
      `🔌 [sendToPrinter] Would send ${data.length} bytes to ${target.ip}:${port}`
    );
  
    // Real implementation (example with react-native-tcp-socket):
  
    // return new Promise<void>((resolve, reject) => {
    //   const client = TcpSocket.createConnection(
    //     { host: target.ip, port },
    //     () => {
    //       client.write(Buffer.from(data));
    //       client.destroy();
    //       resolve();
    //     }
    //   );
    //
    //   client.on("error", (err) => {
    //     client.destroy();
    //     reject(new PrinterError(`Failed to print: ${err.message}`));
    //   });
    // });
  }
  