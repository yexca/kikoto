import { Database, Folder, Plus } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type FileSource } from "@/lib/api";

const sources = [
  { icon: Folder, name: "Main local library", type: "local_folder", status: "enabled", priority: 1 },
  { icon: Database, name: "Home Kikoeru", type: "kikoeru", status: "disabled", priority: 30 },
];

export function SourcesPage({ canManage }: { canManage: boolean }) {
  const [apiSources, setAPISources] = useState<FileSource[]>([]);

  useEffect(() => {
    api.listFileSources().then(setAPISources).catch(() => setAPISources([]));
  }, []);

  const visibleSources =
    apiSources.length > 0
      ? apiSources.map((source, index) => ({
          icon: source.sourceType === "local_folder" ? Folder : Database,
          name: source.displayName,
          type: source.sourceType,
          status: source.enabled ? "enabled" : "disabled",
          priority: index + 1,
        }))
      : sources;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">File sources</h2>
          <p className="text-sm text-muted-foreground">Sources describe where playable or downloadable files live.</p>
        </div>
        <Button size="sm" disabled={!canManage}>
          <Plus className="h-4 w-4" />
          Add source
        </Button>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        {visibleSources.map((source) => (
          <Card key={source.name}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <source.icon className="h-4 w-4 text-primary" />
                {source.name}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">{source.type}</Badge>
                <Badge variant={source.status === "not configured" ? "warning" : "outline"}>{source.status}</Badge>
              </div>
              <div className="text-sm text-muted-foreground">Priority {source.priority}</div>
              <Button variant="outline" size="sm" className="w-full" disabled={!canManage}>
                Configure
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
