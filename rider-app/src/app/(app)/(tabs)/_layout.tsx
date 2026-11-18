import { Tabs } from 'expo-router/js-tabs';
import { ColorValue, Text } from 'react-native';
import { colors } from '@/components/ui';

const icon = (glyph: string) =>
  function TabIcon({ color }: { color: ColorValue }) {
    return <Text style={{ fontSize: 20, color }}>{glyph}</Text>;
  };

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.card },
        headerTintColor: colors.text,
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.muted,
        tabBarLabelStyle: { fontSize: 13 },
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Turno', tabBarIcon: icon('⏱') }} />
      <Tabs.Screen name="mapa" options={{ title: 'Mapa', tabBarIcon: icon('🗺') }} />
      <Tabs.Screen name="ganancias" options={{ title: 'Ganancias', tabBarIcon: icon('$') }} />
    </Tabs>
  );
}
