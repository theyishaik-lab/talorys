import { FlashList } from "@shopify/flash-list";
import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";
import { RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../lib/theme";
import { Screen } from "./Screen";
import { T } from "./ui";

/** A pushed list page (Memory / Tasks / Notes / Automations): pull to refresh, empty text, memoized rows. */
export function ListScreen<T_ extends { id: string }>({
  title,
  load,
  render,
  empty,
  header,
}: {
  title: string;
  load: () => Promise<T_[]>;
  render: (item: T_, reload: () => void) => ReactElement;
  empty: string;
  header?: ReactElement;
}) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<T_[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setItems(await load());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
      setItems((prev) => prev ?? []);
    }
  }, [load]);

  useEffect(() => {
    Promise.resolve().then(reload);
  }, [reload]);

  return (
    <Screen title={title} scroll={false}>
      {header}
      <FlashList
        data={items ?? []}
        keyExtractor={(x) => x.id}
        renderItem={({ item }) => render(item, reload)}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 24 }}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await reload();
              setRefreshing(false);
            }}
            tintColor={c.fgMuted}
          />
        }
        ListEmptyComponent={
          items === null ? null : (
            <T muted center style={{ paddingTop: 40 }}>
              {error ?? empty}
            </T>
          )
        }
      />
    </Screen>
  );
}
