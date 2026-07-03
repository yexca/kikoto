import { Clock3, Filter, Headphones, Search } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api, type Work } from "@/lib/api";

const works = [
  {
    code: "RJ000000",
    title: "Sample work stub",
    circle: "Local library",
    state: ["local", "workflow-ready"],
    progress: "0%",
  },
  {
    code: "RJ111111",
    title: "Remote source placeholder",
    circle: "Kikoeru-compatible",
    state: ["remote", "missing metadata"],
    progress: "42%",
  },
  {
    code: "RJ222222",
    title: "Cached track placeholder",
    circle: "Manual import",
    state: ["cached", "favorite"],
    progress: "81%",
  },
];

export function LibraryPage() {
  const [apiWorks, setAPIWorks] = useState<Work[]>([]);
  const [isAPIAvailable, setIsAPIAvailable] = useState(false);

  useEffect(() => {
    api
      .listWorks()
      .then((items) => {
        setAPIWorks(items);
        setIsAPIAvailable(true);
      })
      .catch(() => {
        setIsAPIAvailable(false);
      });
  }, []);

  const visibleWorks =
    apiWorks.length > 0
      ? apiWorks.map((work) => ({
          code: work.primaryCode,
          title: work.title,
          circle: "Local scan stub",
          state: ["local", "api"],
          progress: "0%",
        }))
      : works;

  return (
    <div className="space-y-5">
      <section className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-h-10 flex-1 items-center gap-2 rounded-lg border bg-card px-3 text-sm text-muted-foreground lg:max-w-xl">
          <Search className="h-4 w-4" />
          <span>Search title, code, circle, tag, or creator</span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm">
            <Filter className="h-4 w-4" />
            Filters
          </Button>
          <Button size="sm">
            <Headphones className="h-4 w-4" />
            {isAPIAvailable ? "API connected" : "Preview data"}
          </Button>
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {visibleWorks.map((work) => (
          <Card key={work.code} className="overflow-hidden">
            <CardContent className="grid min-h-[156px] grid-cols-[88px_minmax(0,1fr)] gap-4 p-4">
              <div className="grid aspect-square place-items-center rounded-lg bg-primary text-lg font-bold text-primary-foreground">
                {work.code.slice(0, 2)}
              </div>
              <div className="min-w-0">
                <div className="text-xs font-medium text-muted-foreground">{work.code}</div>
                <h2 className="mt-1 truncate text-base font-semibold">{work.title}</h2>
                <p className="mt-1 truncate text-sm text-muted-foreground">{work.circle}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {work.state.map((state) => (
                    <Badge key={state} variant={state === "missing metadata" ? "warning" : "secondary"}>
                      {state}
                    </Badge>
                  ))}
                </div>
                <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                  <Clock3 className="h-3.5 w-3.5" />
                  {work.progress} listened
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </section>
    </div>
  );
}
