// Wallet layer: wagmi on HyperEVM (chain 999) with injected wallets
// (MetaMask, Rabby, Frame, Rainbow…).

import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createPublicClient, http, formatUnits, parseAbi } from "viem";
import { arbitrum, mainnet } from "viem/chains";
import {
  WagmiProvider,
  createConfig,
  useAccount,
  useBalance,
  useConnect,
  useDisconnect,
  useReadContract,
  useSwitchChain,
} from "wagmi";
import { injected } from "wagmi/connectors";
import { CONTRACTS, ERC20_ABI, hyperevm, shortAddr } from "./chain";
import { useI18n } from "./i18n";

export const wagmiConfig = createConfig({
  chains: [hyperevm],
  connectors: [injected()],
  transports: { [hyperevm.id]: http() },
});

const queryClient = new QueryClient();

export function WalletProvider({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}

export function useUsdcBalance() {
  const { address } = useAccount();
  const { data, isLoading } = useReadContract({
    address: CONTRACTS.usdc as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 15_000 },
  });
  // Native Circle USDC uses 6 decimals
  return { usdc: data != null ? Number(formatUnits(data as bigint, 6)) : null, isLoading };
}

// ---- deposit proxy -----------------------------------------------------------

const FACTORY_ABI = parseAbi([
  "function computeProxyAddress(address user) view returns (address)",
]);

/** The user's personal deposit address (CREATE2, read from their factory). */
export function useDepositProxy() {
  const { address } = useAccount();
  const { data } = useReadContract({
    address: CONTRACTS.depositProxyFactory as `0x${string}`,
    abi: FACTORY_ABI,
    functionName: "computeProxyAddress",
    args: address ? [address] : undefined,
    query: { enabled: !!address, staleTime: Infinity },
  });
  return (data as `0x${string}` | undefined) ?? null;
}

// ---- balances on other chains (read-only, public RPCs — same ones their app uses)

const FOREIGN = {
  ethereum: {
    client: createPublicClient({ chain: mainnet, transport: http("https://ethereum-rpc.publicnode.com") }),
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as `0x${string}`,
  },
  arbitrum: {
    client: createPublicClient({ chain: arbitrum, transport: http("https://arb1.arbitrum.io/rpc") }),
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as `0x${string}`,
  },
};

export function useForeignUsdc(chain: keyof typeof FOREIGN) {
  const { address } = useAccount();
  const { data } = useQuery({
    queryKey: ["foreign-usdc", chain, address],
    enabled: !!address,
    staleTime: 60_000,
    queryFn: async () => {
      const { client, usdc } = FOREIGN[chain];
      const bal = await client.readContract({
        address: usdc,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [address!],
      });
      return Number(formatUnits(bal as bigint, 6));
    },
  });
  return data ?? null;
}

/** USDC on the user's Hyperliquid (HyperCore) spot account. */
export function useHyperCoreUsdc() {
  const { address } = useAccount();
  const { data } = useQuery({
    queryKey: ["hypercore-usdc", address],
    enabled: !!address,
    staleTime: 30_000,
    queryFn: async () => {
      const res = await fetch("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "spotClearinghouseState", user: address }),
      });
      if (!res.ok) return 0;
      const j = await res.json();
      const row = (j.balances ?? []).find((b: any) => b.coin === "USDC");
      return row ? Number(row.total) : 0;
    },
  });
  return data ?? null;
}

/** Topbar wallet controls: connect, wrong-chain switch, address + disconnect. */
export function ConnectControls() {
  const { t } = useI18n();
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const { data: native } = useBalance({ address, query: { enabled: !!address } });
  const { usdc } = useUsdcBalance();

  if (!isConnected) {
    return (
      <button
        className="topbtn"
        disabled={isPending}
        onClick={() => connect({ connector: connectors[0] })}
      >
        {isPending ? t("top.connecting") : t("top.connect")}
      </button>
    );
  }

  if (chainId !== hyperevm.id) {
    return (
      <button className="topbtn warn" title={t("top.wrongNetwork")} onClick={() => switchChain({ chainId: hyperevm.id })}>
        {t("top.switchNetwork")}
      </button>
    );
  }

  return (
    <div className="wallet-chip" title={address}>
      <span className="wallet-balances">
        {usdc != null && <b>{usdc.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC</b>}
        {native && (
          <span className="muted">
            {Number(formatUnits(native.value, 18)).toFixed(3)} HYPE
          </span>
        )}
      </span>
      <span className="wallet-addr">{shortAddr(address!)}</span>
      <button className="wallet-x" onClick={() => disconnect()} title={t("top.disconnect")}>
        ×
      </button>
    </div>
  );
}
