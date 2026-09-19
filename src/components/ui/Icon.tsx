import type { SVGProps } from "react";
import {
  BookOpen,
  Compass,
  Library,
  SlidersHorizontal,
  Plus,
  Search,
  MoreHorizontal,
  FolderOpen,
  RefreshCw,
  Cloud,
  Grid2X2,
  List,
  Tag,
  ChartPie,
  Clock,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Bookmark,
  X,
  Type,
  Sun,
  Moon,
  Check,
  Settings,
  TrendingUp,
  Space,
  Rss,
  Inbox,
  Tornado,
  Eye,
  Rocket,
  Castle,
  Sprout,
  Swords,
  Flower2,
  Save,
} from "lucide-react";
const icons = {
  auto_stories: BookOpen,
  explore: Compass,
  collections_bookmark: Library,
  tune: SlidersHorizontal,
  add: Plus,
  search: Search,
  more_horiz: MoreHorizontal,
  folder_open: FolderOpen,
  sync: RefreshCw,
  cloud: Cloud,
  grid_view: Grid2X2,
  view_list: List,
  list: List,
  label: Tag,
  pie_chart: ChartPie,
  schedule: Clock,
  arrow_back: ArrowLeft,
  chevron_left: ChevronLeft,
  chevron_right: ChevronRight,
  bookmark: Bookmark,
  bookmark_border: Bookmark,
  close: X,
  format_size: Type,
  light_mode: Sun,
  dark_mode: Moon,
  check: Check,
  settings: Settings,
  insights: TrendingUp,
  space_bar: Space,
  rss_feed: Rss,
  all_inbox: Inbox,
  refresh: RefreshCw,
  cyclone: Tornado,
  import_contacts: BookOpen,
  visibility: Eye,
  rocket_launch: Rocket,
  fort: Castle,
  potted_plant: Sprout,
  swords: Swords,
  local_florist: Flower2,
  save: Save,
};
interface IconProps extends Omit<SVGProps<SVGSVGElement>, "fill"> {
  name: string;
  size?: number | string;
  fill?: boolean;
}
export function Icon({ name, size = 20, fill: filled, ...props }: IconProps) {
  const Glyph = icons[name as keyof typeof icons] ?? BookOpen;
  return (
    <Glyph
      width={size}
      height={size}
      aria-hidden="true"
      strokeWidth={filled ? 2.4 : 1.8}
      {...props}
    />
  );
}
