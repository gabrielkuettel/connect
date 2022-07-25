import WalletConnect from "@walletconnect/client";
import {formatJsonRpcRequest} from "@json-rpc-tools/utils/dist/cjs/format";

import PeraWalletConnectError from "./util/PeraWalletConnectError";
import {
  openPeraWalletConnectModal,
  openPeraWalletRedirectModal,
  removeModalWrapperFromDOM,
  PERA_WALLET_CONNECT_MODAL_ID,
  PERA_WALLET_REDIRECT_MODAL_ID
} from "./modal/peraWalletConnectModalUtils";
import {
  getWalletDetailsFromStorage,
  resetWalletDetailsFromStorage,
  saveWalletDetailsToStorage
} from "./util/storage/storageUtils";
import {assignBridgeURL, listBridgeServers} from "./util/api/peraWalletConnectApi";
import {PERA_WALLET_LOCAL_STORAGE_KEYS} from "./util/storage/storageConstants";
import {PeraWalletTransaction, SignerTransaction} from "./util/model/peraWalletModels";
import {
  base64ToUint8Array,
  encodeUnsignedTransactionInBase64
} from "./util/transaction/transactionUtils";
import {isMobile} from "./util/device/deviceUtils";
import {AppMeta} from "./util/peraWalletTypes";
import {getPeraWalletAppMeta} from "./util/peraWalletUtils";
import appTellerManager, {PeraTeller} from "./util/network/teller/appTellerManager";

interface PeraWalletConnectOptions {
  bridge?: string;
  deep_link?: string;
  app_meta?: AppMeta;
}

function generatePeraWalletConnectModalActions(
  resolvePromise?: (accounts: string[]) => void,
  rejectPromise?: (error: any) => void
) {
  return {
    open: openPeraWalletConnectModal(resolvePromise, rejectPromise),
    close: () => removeModalWrapperFromDOM(PERA_WALLET_CONNECT_MODAL_ID)
  };
}

class PeraWalletConnect {
  bridge: string;
  connector: WalletConnect | null;

  constructor(options?: PeraWalletConnectOptions) {
    this.bridge =
      options?.bridge ||
      localStorage.getItem(PERA_WALLET_LOCAL_STORAGE_KEYS.BRIDGE_URL) ||
      "";

    if (options?.deep_link) {
      localStorage.setItem(PERA_WALLET_LOCAL_STORAGE_KEYS.DEEP_LINK, options.deep_link);
    }

    if (options?.app_meta) {
      localStorage.setItem(
        PERA_WALLET_LOCAL_STORAGE_KEYS.APP_META,
        JSON.stringify(options.app_meta)
      );
    }

    this.connector = null;
  }

  connect() {
    return new Promise<string[]>(async (resolve, reject) => {
      try {
        // check if already connected and kill session first before creating a new one.
        // This is to kill the last session and make sure user start from scratch whenever `.connect()` method is called.
        if (this.connector?.connected) {
          await this.connector.killSession();
        }

        let bridgeURL = "";

        if (!this.bridge) {
          bridgeURL = await assignBridgeURL();
        }

        // Create Connector instance
        this.connector = new WalletConnect({
          bridge: this.bridge || bridgeURL,
          qrcodeModal: generatePeraWalletConnectModalActions(resolve, reject)
        });

        await this.connector.createSession({
          chainId: 4160
        });

        this.connector.on("connect", (error, _payload) => {
          if (error) {
            reject(error);
          }

          resolve(this.connector?.accounts || []);

          saveWalletDetailsToStorage(this.connector?.accounts || []);
        });
      } catch (error: any) {
        console.log(error);

        const {name} = getPeraWalletAppMeta();

        reject(
          new PeraWalletConnectError(
            {
              type: "SESSION_CONNECT",
              detail: error
            },
            error.message || `There was an error while connecting to ${name}`
          )
        );
      }
    });
  }

  async reconnectSession() {
    try {
      const walletDetails = getWalletDetailsFromStorage();

      if (walletDetails?.type === "pera-wallet-web") {
        return walletDetails.accounts || [];
      }

      if (this.connector) {
        return this.connector.accounts || [];
      }

      // Fetch the active bridge servers
      const response = await listBridgeServers();

      if (response.servers.includes(this.bridge)) {
        this.connector = new WalletConnect({
          bridge: this.bridge,
          qrcodeModal: generatePeraWalletConnectModalActions()
        });

        return this.connector?.accounts || [];
      }

      throw new PeraWalletConnectError(
        {
          type: "SESSION_RECONNECT",
          detail: ""
        },
        "The bridge server is not active anymore. Disconnecting."
      );
    } catch (error: any) {
      // If the bridge is not active, then disconnect
      this.disconnect();

      const {name} = getPeraWalletAppMeta();

      throw new PeraWalletConnectError(
        {
          type: "SESSION_RECONNECT",
          detail: error
        },
        error.message || `There was an error while reconnecting to ${name}`
      );
    }
  }

  disconnect() {
    const killPromise = this.connector?.killSession();

    killPromise?.then(() => {
      this.connector = null;
    });

    resetWalletDetailsFromStorage();

    return killPromise;
  }

  async signTransaction(
    txGroups: SignerTransaction[][],
    signerAddress?: string
  ): Promise<Uint8Array[]> {
    const walletDetails = getWalletDetailsFromStorage();

    if (walletDetails?.type === "pera-wallet") {
      if (isMobile()) {
        // This is to automatically open the wallet app when trying to sign with it.
        openPeraWalletRedirectModal();
      }

      if (!this.connector) {
        throw new Error("PeraWalletConnect was not initialized correctly.");
      }
    }

    const signTxnRequestParams = txGroups.flatMap((txGroup) =>
      txGroup.map<PeraWalletTransaction>((txGroupDetail) => {
        let signers: PeraWalletTransaction["signers"];

        if (signerAddress && !(txGroupDetail.signers || []).includes(signerAddress)) {
          signers = [];
        }

        const txnRequestParams: PeraWalletTransaction = {
          txn: encodeUnsignedTransactionInBase64(txGroupDetail.txn)
        };

        if (Array.isArray(signers)) {
          txnRequestParams.signers = signers;
        }

        return txnRequestParams;
      })
    );

    // ================================================= //
    // Pera Wallet Web flow
    if (walletDetails?.type === "pera-wallet-web") {
      const peraWalletIframe = document.createElement("iframe");

      peraWalletIframe.setAttribute("id", "pera-wallet-iframe");
      peraWalletIframe.setAttribute("src", "https://localhost:3000/transaction/sign");

      document.body.appendChild(peraWalletIframe);

      if (peraWalletIframe.contentWindow) {
        appTellerManager.sendMessage({
          message: {
            type: "SIGN_TXN",
            txn: signTxnRequestParams
          },

          origin: "https://localhost:3000",
          targetWindow: peraWalletIframe.contentWindow
        });
      }

      return new Promise<Uint8Array[]>((resolve, reject) => {
        appTellerManager.setupListener({
          onReceiveMessage: (event: MessageEvent<TellerMessage<PeraTeller>>) => {
            if (event.data.message.type === "SIGN_TXN_CALLBACK") {
              document.getElementById("pera-wallet-iframe")?.remove();

              resolve(
                event.data.message.signedTxns.map((txn_1) =>
                  base64ToUint8Array(txn_1.signedTxn)
                )
              );
            }

            if (event.data.message.type === "SESSION_DISCONNECTED") {
              document.getElementById("pera-wallet-iframe")?.remove();

              resetWalletDetailsFromStorage();

              reject(event.data.message.error);
            }
          }
        });
      });
    }
    // ================================================= //

    // ================================================= //
    // Pera Mobile Wallet flow
    const formattedSignTxnRequest = formatJsonRpcRequest("algo_signTxn", [
      signTxnRequestParams
    ]);

    try {
      try {
        const response = await this.connector!.sendCustomRequest(formattedSignTxnRequest);
        // We send the full txn group to the mobile wallet.
        // Therefore, we first filter out txns that were not signed by the wallet.
        // These are received as `null`.
        const nonNullResponse = response.filter(Boolean) as (string | number[])[];

        return typeof nonNullResponse[0] === "string"
          ? (nonNullResponse as string[]).map(base64ToUint8Array)
          : (nonNullResponse as number[][]).map((item) => Uint8Array.from(item));
      } catch (error) {
        return await Promise.reject(
          new PeraWalletConnectError(
            {
              type: "SIGN_TRANSACTIONS",
              detail: error
            },
            error.message || "Failed to sign transaction"
          )
        );
      }
    } finally {
      removeModalWrapperFromDOM(PERA_WALLET_REDIRECT_MODAL_ID);
    }
    // ================================================= //
  }
}

export default PeraWalletConnect;
