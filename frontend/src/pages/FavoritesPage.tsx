import {
  Clock3,
  Headphones,
  Heart,
  ListMusic,
  Pause,
  Play,
  Plus,
  Search,
  SlidersHorizontal,
  Star,
  Tags,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const markBuckets = [
  { label: "Want", count: 18, icon: Star },
  { label: "Listening", count: 7, icon: Play },
  { label: "Paused", count: 4, icon: Pause },
  { label: "Finished", count: 42, icon: Headphones },
  { label: "Relisten", count: 9, icon: Clock3 },
];

const playlists = [
  { title: "Demo List 001", count: 23, duration: "12h 40m", updated: "Updated on fake date", tags: ["demo-tag-a", "demo-tag-b"] },
  { title: "Demo List 002", count: 16, duration: "9h 05m", updated: "Updated on fake date", tags: ["demo-tag-c", "demo-tag-d"] },
  { title: "Demo List 003", count: 31, duration: "6h 18m", updated: "Updated on fake date", tags: ["demo-tag-e"] },
];

const userTags = [
  { name: "fake-user-tag-001", count: 28 },
  { name: "fake-user-tag-002", count: 17 },
  { name: "fake-user-tag-003", count: 11 },
  { name: "fake-user-tag-004", count: 6 },
  { name: "fake-user-tag-005", count: 4 },
];

const works = [
  {
    code: "RJ0123456",
    title: "Demo Work Title 001",
    circle: "Fake Circle 001",
    mark: "Listening",
    progress: "42%",
    list: "Demo List 001",
    userTags: ["fake-user-tag-001", "fake-user-tag-002"],
    source: "Local + Cached",
  },
  {
    code: "RJ0234567",
    title: "Demo Work Title 002",
    circle: "Fake Circle 002",
    mark: "Want",
    progress: "0%",
    list: "Demo List 002",
    userTags: ["fake-user-tag-003"],
    source: "Remote available",
  },
  {
    code: "RJ0345678",
    title: "Demo Work Title 003",
    circle: "Fake Circle 003",
    mark: "Relisten",
    progress: "100%",
    list: "Demo List 003",
    userTags: ["fake-user-tag-005"],
    source: "Local",
  },
];

export function FavoritesPage() {
  return (
    <div className="space-y-5">
      <section className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-sm text-muted-foreground">Personal marks, lists, and user tags</p>
          <h2 className="text-xl font-semibold">Listening Desk</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm">
            <Search className="h-4 w-4" />
            Search
          </Button>
          <Button variant="outline" size="sm">
            <SlidersHorizontal className="h-4 w-4" />
            Filters
          </Button>
          <Button size="sm">
            <Plus className="h-4 w-4" />
            New list
          </Button>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {markBuckets.map((bucket) => (
          <Card key={bucket.label}>
            <CardContent className="flex items-center justify-between p-4">
              <div>
                <div className="text-2xl font-semibold">{bucket.count}</div>
                <div className="text-sm text-muted-foreground">{bucket.label}</div>
              </div>
              <bucket.icon className="h-5 w-5 text-primary" />
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <div className="grid gap-3 lg:grid-cols-3">
            {playlists.map((playlist) => (
              <Card key={playlist.title}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <ListMusic className="h-4 w-4 text-primary" />
                    {playlist.title}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="text-sm text-muted-foreground">
                    {playlist.count} works · {playlist.duration}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {playlist.tags.map((tag) => (
                      <Badge key={tag} variant="outline">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                  <div className="text-xs text-muted-foreground">{playlist.updated}</div>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Marked Works</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {works.map((work) => (
                <div key={work.code} className="grid gap-3 rounded-md border bg-background p-3 text-sm lg:grid-cols-[minmax(0,1fr)_140px_160px] lg:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{work.code}</Badge>
                      <Badge>{work.mark}</Badge>
                      <span className="text-xs text-muted-foreground">{work.progress}</span>
                    </div>
                    <div className="mt-2 truncate font-medium">{work.title}</div>
                    <div className="truncate text-xs text-muted-foreground">{work.circle}</div>
                  </div>
                  <div className="text-xs text-muted-foreground">{work.list}</div>
                  <div className="flex flex-wrap gap-1">
                    {work.userTags.map((tag) => (
                      <Badge key={tag} variant="outline">
                        {tag}
                      </Badge>
                    ))}
                    <Badge variant="secondary">{work.source}</Badge>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Tags className="h-4 w-4 text-primary" />
              User Tags
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {userTags.map((tag) => (
              <button key={tag.name} className="flex min-h-10 w-full items-center justify-between rounded-md border bg-background px-3 text-left text-sm hover:bg-muted">
                <span>{tag.name}</span>
                <Badge variant="outline">{tag.count}</Badge>
              </button>
            ))}
            <Button variant="outline" size="sm" className="w-full">
              <Plus className="h-4 w-4" />
              Add tag
            </Button>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
